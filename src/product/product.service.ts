import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { Product } from './product.entity';
import { IntentService } from '../search/intent.service';
import { VirtualTryOnService } from './virtual-try-on.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import axios from 'axios';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

@Injectable()
export class ProductService {
  private readonly runpodUrl = process.env.RUNPOD_URL_CR_AND_EMBED;
  private readonly runpodApiKey = process.env.RUNPOD_API_KEY;
  private readonly opensearchIndex = 'ff_products_current';
  private get opensearchHeaders() {
    const creds = Buffer.from(
      `admin:${process.env.OPENSEARCH_PASSWORD}`,
    ).toString('base64');
    return {
      'Content-Type': 'application/json',
      Authorization: `Basic ${creds}`,
    };
  }

  constructor(
    @InjectRepository(Product)
    private readonly repo: Repository<Product>,
    private readonly intentService: IntentService,
    private readonly virtualTryOnService: VirtualTryOnService,
    private readonly supabaseService: SupabaseService,
  ) {}

  private assertRunpodConfig() {
    if (!this.runpodUrl || !this.runpodApiKey) {
      throw new Error('Missing RUNPOD_URL or RUNPOD_API_KEY env variables');
    }
  }

  private async fetchRandomUserPhotos(
    userId: string,
    limit = 5,
  ): Promise<string[]> {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from('users_profile_images')
      .select('url')
      .eq('users_id', userId);

    if (error) {
      throw new Error(`Supabase fetch error: ${error.message}`);
    }
    if (!data?.length) return [];

    const shuffled = [...data].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, limit).map((row) => row.url);
  }

  private extractDetections(payload: any): any[] {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;

    const candidates = [
      payload.detections,
      payload.predictions,
      payload.objects,
      payload.result,
      payload.output,
      payload.data,
    ];

    for (const entry of candidates) {
      if (Array.isArray(entry)) return entry;
      if (entry && Array.isArray(entry.detections)) return entry.detections;
      if (entry && Array.isArray(entry.predictions)) return entry.predictions;
      if (entry && Array.isArray(entry.objects)) return entry.objects;
    }
    return [];
  }

  private async runpodTopDetection(imageUrl: string) {
    this.assertRunpodConfig();

    let res: Response;
    try {
      res = await fetch(this.runpodUrl!, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.runpodApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image_url: imageUrl }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err: any) {
      const code = err?.cause?.code ?? err?.code ?? 'unknown';
      const reason = err?.message ?? 'fetch failed';
      throw new Error(`RunPod request failed (${code}): ${reason}`);
    }

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`RunPod error ${res.status}: ${txt.slice(0, 500)}`);
    }

    const payload = await res.json();
    console.log(payload);
    const detections = this.extractDetections(payload);
    if (!detections.length) return null;

    const top = detections.reduce((best, curr) => {
      const bestConf = Number(best?.confidence ?? best?.score ?? 0);
      const currConf = Number(curr?.confidence ?? curr?.score ?? 0);
      return currConf > bestConf ? curr : best;
    });

    if (!top?.embedding) return null;

    return {
      className: top.class_name ?? top.class ?? top.label ?? 'unknown',
      confidence: Number(top.confidence ?? top.score ?? 0),
      embedding: top.embedding as number[],
    };
  }

  private readonly PAGE_SIZE = 32;
  private readonly MAX_PAGES = 10;

  private async vectorSearchByEmbedding(
    embedding: number[],
    size = 32,
    from = 0,
  ) {
    const body = {
      from,
      size,
      _source: {
        excludes: ['openclip_img_embedding', 'openclip_txt_embedding'],
      },
      query: {
        knn: {
          openclip_img_embedding: {
            vector: embedding,
            k: from + size,
          },
        },
      },
    };

    const res = await fetch(
      `${process.env.OPENSEARCH_URL}/${this.opensearchIndex}/_search`,
      {
        method: 'POST',
        headers: this.opensearchHeaders,
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(
        `OpenSearch vector error ${res.status}: ${txt.slice(0, 500)}`,
      );
    }

    const data = await res.json();
    const totalHits = data.hits?.total?.value ?? 0;
    const items =
      data.hits?.hits?.map((h: any) => ({
        id: h._id,
        score: h._score,
        ...h._source,
      })) || [];
    return { items, total: totalHits };
  }

  private logTopProductImage(products: any[], sourceLabel: string) {
    if (!products?.length) return;
    const top = products[0];
    const img =
      top?.image_url ??
      top?.image ??
      (Array.isArray(top?.image_urls) ? top.image_urls[0] : undefined);
    console.log(`[recs] top product image for ${sourceLabel}:`, img);
  }

  async recommendFromUserPhotos(userId: string) {
    if (!userId) throw new Error('User ID required');

    const photos = await this.fetchRandomUserPhotos(userId, 5);
    if (!photos.length) return [];

    const results = [] as any[];

    for (const photoUrl of photos) {
      try {
        const detection = await this.runpodTopDetection(photoUrl);
        if (!detection?.embedding) continue;

        const { items: products } = await this.vectorSearchByEmbedding(
          detection.embedding,
          10,
        );

        this.logTopProductImage(products, photoUrl);

        results.push({
          sourceImage: photoUrl,
          className: detection.className,
          confidence: detection.confidence,
          products,
        });
      } catch (err: any) {
        console.error(
          `Photo recommendation failed for ${photoUrl}: ${err.message}`,
        );
      }
    }

    return results;
  }

  async recommendFromProvidedPhotos(images: string[]) {
    if (!Array.isArray(images) || images.length === 0) return [];

    const results = [] as any[];
    const limitedImages = images.slice(0, 10);

    for (const photoUrl of limitedImages) {
      try {
        const detection = await this.runpodTopDetection(photoUrl);
        if (!detection?.embedding) continue;

        const { items: products } = await this.vectorSearchByEmbedding(
          detection.embedding,
          10,
        );

        this.logTopProductImage(products, photoUrl);

        results.push({
          sourceImage: photoUrl,
          className: detection.className,
          confidence: detection.confidence,
          products,
        });
      } catch (err: any) {
        console.error(
          `Provided photo recommendation failed for ${photoUrl}: ${err.message}`,
        );
      }
    }

    return results;
  }

  async recommendFromTextEmbeddings(userId: string) {
    if (!userId) throw new Error('User ID required');

    const supabase = this.supabaseService.getClient();
    const { data: images, error } = await supabase
      .from('users_profile_images')
      .select('url, recommendation, reason, recommendation_embedding')
      .eq('users_id', userId)
      .not('recommendation_embedding', 'is', null);

    if (error) throw new Error(error.message);
    if (!images?.length) return [];

    const results: any[] = [];
    for (const img of images) {
      try {
        const embedding =
          typeof img.recommendation_embedding === 'string'
            ? JSON.parse(img.recommendation_embedding)
            : img.recommendation_embedding;
        const { items: products } = await this.vectorSearchByEmbedding(
          embedding,
          5,
        );
        this.logTopProductImage(products, img.url);
        results.push({
          sourceImage: img.url,
          recommendation: img.recommendation,
          reason: img.reason,
          products,
        });
      } catch (err: any) {
        console.error(`Vector search failed for ${img.url}: ${err.message}`);
      }
    }

    return results;
  }

  async recommendFromSingleTextEmbedding(
    userId: string,
    imageUrl: string,
    page = 1,
  ) {
    if (!userId) throw new Error('User ID required');
    if (!imageUrl) throw new Error('Image URL required');

    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from('users_profile_images')
      .select('url, recommendation, reason, recommendation_embedding')
      .eq('users_id', userId)
      .eq('url', imageUrl)
      .not('recommendation_embedding', 'is', null)
      .single();

    if (error) throw new Error(error.message);
    if (!data)
      return { sourceImage: imageUrl, products: [], page: 1, totalPages: 0 };

    const embedding =
      typeof data.recommendation_embedding === 'string'
        ? JSON.parse(data.recommendation_embedding)
        : data.recommendation_embedding;

    const from = (page - 1) * this.PAGE_SIZE;
    const { items } = await this.vectorSearchByEmbedding(
      embedding,
      this.PAGE_SIZE,
      from,
    );
    const totalPages = this.MAX_PAGES;

    return {
      sourceImage: data.url,
      recommendation: data.recommendation,
      reason: data.reason,
      products: items,
      page,
      totalPages,
    };
  }

  private async fetchUserProfile(userId: string) {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from('users_profile')
      .select('aesthetic_archetype, color_pattern_affinity, lifestyle_occasion')
      .eq('id', userId)
      .single();
    if (error || !data) return null;
    return data;
  }

  async search(query: any, userId?: string) {
    const title = query?.title?.trim();
    const page = Math.max(1, Number(query?.page) || 1);
    const from = (page - 1) * this.PAGE_SIZE;

    // Fetch user profile for style boosts
    const profile = userId ? await this.fetchUserProfile(userId) : null;

    // Build should clauses for soft style boosts
    const shouldClauses: any[] = [];
    if (profile?.aesthetic_archetype) {
      shouldClauses.push({
        terms: { aesthetic_archetypes: [profile.aesthetic_archetype], boost: 2.5 },
      });
    }
    if (profile?.color_pattern_affinity) {
      shouldClauses.push({
        terms: { color_pattern_affinity: [profile.color_pattern_affinity], boost: 1.8 },
      });
    }
    if (profile?.lifestyle_occasion) {
      shouldClauses.push({
        terms: { lifestyle_occasion: [profile.lifestyle_occasion], boost: 1.2 },
      });
    }

    const dsl: any = {
      from,
      size: this.PAGE_SIZE,
      _source: {
        excludes: ['openclip_img_embedding', 'openclip_txt_embedding'],
      },
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query: title,
                fields: ['title^4', 'description^1.5', 'search_text^2'],
                type: 'best_fields',
                operator: 'or',
              },
            },
          ],
          ...(shouldClauses.length > 0 ? { should: shouldClauses } : {}),
        },
      },
    };

    const res = await fetch(
      `${process.env.OPENSEARCH_URL}/${this.opensearchIndex}/_search`,
      {
        method: 'POST',
        headers: this.opensearchHeaders,
        body: JSON.stringify(dsl),
      },
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`OpenSearch error ${res.status}: ${txt.slice(0, 500)}`);
    }
    const data = await res.json();
    const totalHits = data.hits?.total?.value ?? 0;
    const totalPages = Math.min(
      Math.ceil(totalHits / this.PAGE_SIZE),
      this.MAX_PAGES,
    );

    return {
      items: data.hits.hits.map((h: any) => ({
        id: h._id,
        score: h._score,
        ...h._source,
      })),
      page,
      totalPages,
    };
  }

  async findReview(query: any) {
    console.log('yes');
    const product = query?.product;
    const merchant = query?.merchant;
    return await this.intentService.searchReview(product, merchant);
  }

  async findOne(id: string) {
    console.log('Search endpoint called', id);
    console.log(id, 'queryID');

    const res = await fetch(
      `${process.env.OPENSEARCH_URL}/ff_products_current/_doc/${id}`,
      {
        method: 'GET',
        headers: this.opensearchHeaders,
      },
    );
    if (!res.ok) {
      console.log(res.status, 'not ok');
      const txt = await res.text();
      throw new Error(`OpenSearch error ${res.status}: ${txt.slice(0, 500)}`);
    }
    const data = await res.json();
    console.log(data, '✅ the specific route param');

    return { id: data._id, ...data._source };
  }

  async virtualTryOn(referenceImage: string, userId: string) {
    console.log('virtual try on called!');
    const supabase = this.supabaseService.getClient();

    // 1. Get user's featured image as source
    const { data: featured, error: featErr } = await supabase
      .from('users_profile_images')
      .select('url')
      .eq('users_id', userId)
      .eq('is_featured', true)
      .single();
    if (featErr || !featured) throw new Error('No featured image found');
    const sourceImage = featured.url;

    // 2. Look up garment class via product_images → product_types
    const { data: prodImg, error: piErr } = await supabase
      .from('product_images')
      .select('product_id')
      .eq('image_url', referenceImage)
      .single();
    if (piErr || !prodImg) throw new Error('Product image not found');
    console.log('lookup ok');
    const { data: prodType, error: ptErr } = await supabase
      .from('product_types')
      .select('type')
      .eq('product_id', prodImg.product_id)
      .single();
    if (ptErr || !prodType) throw new Error('Product type not found');

    // 3. Reject accessories
    if (prodType.type === 'ACCESSORIES') {
      throw new Error('Accessories are not supported for virtual try-on');
    }
    console.log('nova try on start');
    // 4. Call Nova try-on
    const result = await this.virtualTryOnService.virtualTryOn(
      sourceImage,
      referenceImage,
      prodType.type,
    );

    // 5. Store result URL to DB
    await supabase
      .from('users_profile_images')
      .update({ try_on_result: result.resultUrl })
      .eq('users_id', userId)
      .eq('is_featured', true);

    return result;
  }

  private async downloadImageBytes(url: string): Promise<Buffer> {
    const res = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(res.data);
  }

  async styleAnalysis(productId: string, userId: string) {
    // 1. Fetch product details
    const product = await this.findOne(productId);
    const productImage = product?.image_urls?.[0] ?? product?.image_url;

    // 2. Fetch up to 5 random user photos
    const userPhotos = await this.fetchRandomUserPhotos(userId, 5);

    // 3. Download all images as bytes for Bedrock Converse
    const allUrls = [...userPhotos, ...(productImage ? [productImage] : [])];
    const imageBuffers = await Promise.all(
      allUrls.map((url) => this.downloadImageBytes(url)),
    );

    // 4. Build Converse content blocks
    const contentBlocks: any[] = imageBuffers.map((buf) => ({
      image: { format: 'jpeg', source: { bytes: buf } },
    }));

    contentBlocks.push({
      text:
        `Product: "${product.title}"\nPrice: $${product.price_min}–$${product.price_max}\n\n` +
        `The first ${userPhotos.length} image(s) are the user's photos. The last image is the product they are viewing.\n` +
        `Give a personalized style analysis.`,
    });

    // 5. Call Nova Pro via Bedrock Converse
    const bedrock = new BedrockRuntimeClient({
      region: 'us-east-1',
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 30_000,
        socketTimeout: 120_000,
      }),
    });

    const command = new ConverseCommand({
      modelId: 'amazon.nova-pro-v1:0',
      system: [
        {
          text:
            'You are a personal fashion stylist AI. Based on the user\'s photos and the product they\'re viewing, write a brief personalized style analysis (1–3 sentences). ' +
            'Comment on how this piece fits their style, suggest how to wear it, or note what makes it a good (or tricky) match. ' +
            'Use markdown for emphasis (**bold** for key points). Keep it warm, concise, and insightful. ' +
            'Use clean line breaks between sentences for better readability.',
        },
      ],
      messages: [{ role: 'user', content: contentBlocks }],
      inferenceConfig: { maxTokens: 300 },
    });

    const response = await bedrock.send(command);
    const text =
      response.output?.message?.content?.[0]?.text ?? '';

    return { analysis: text };
  }
}
