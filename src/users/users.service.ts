import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Users } from './users.entity';
import { ConflictException } from '@nestjs/common';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import * as bcrypt from 'bcryptjs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class UserService {
  private s3Client: S3Client;
  private bedrockClient: BedrockRuntimeClient;
  private readonly bucketName = 'furnfitdemo';

  constructor(
    @InjectRepository(Users)
    private readonly userRepo: Repository<Users>,
    private readonly supabaseService: SupabaseService,
  ) {
    this.s3Client = new S3Client({ region: 'us-west-2' });
    this.bedrockClient = new BedrockRuntimeClient({
      region: 'us-east-1',
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 30_000,
        socketTimeout: 120_000,
      }),
    });
  }

  private async downloadImage(url: string): Promise<Buffer> {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  }

  private async uploadToS3(
    imageBuffer: Buffer,
    filename: string,
  ): Promise<string> {
    console.log(`📤 [S3 Upload] Starting upload...`);
    console.log(`   Bucket: ${this.bucketName}`);
    console.log(`   Key: ${filename}`);
    console.log(`   Buffer size: ${imageBuffer.length} bytes`);

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: filename,
      Body: imageBuffer,
      ContentType: 'image/jpeg',
    });

    try {
      const result = await this.s3Client.send(command);
      console.log(`✅ [S3 Upload] Success!`);
      console.log(`   ETag: ${result.ETag}`);
    } catch (error) {
      console.error(`❌ [S3 Upload] Failed!`);
      console.error(`   Error: ${error.message}`);
      throw error;
    }

    // Return public URL
    const url = `https://${this.bucketName}.s3.amazonaws.com/${filename}`;
    console.log(`   URL: ${url}`);
    return url;
  }
  // download images => upload s3 AND write DB
  async uploadUserProfileImages(
    userId: string,
    imageUrls: string[],
  ): Promise<string[]> {
    console.log(`\n🖼️  [Profile Images] Starting upload for user: ${userId}`);
    console.log(`   Total images to process: ${imageUrls.length}`);

    const uploadedUrls: string[] = [];
    const supabase = this.supabaseService.getClient();

    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i];
      console.log(`\n📷 [Image ${i + 1}/${imageUrls.length}] Processing...`);
      console.log(`   Source URL: ${imageUrl.substring(0, 80)}...`);

      try {
        // 1. Download image from Instagram
        console.log(`   ⬇️  Downloading image...`);
        const imageBuffer = await this.downloadImage(imageUrl);
        console.log(`   ✅ Downloaded: ${imageBuffer.length} bytes`);

        // 2. Generate unique filename and upload to S3
        const filename = `profile-images/${userId}/${randomUUID()}.jpg`;
        const s3Url = await this.uploadToS3(imageBuffer, filename);

        // 3. Save URL to Supabase
        console.log(`   💾 Saving to Supabase...`);
        const { error } = await supabase.from('users_profile_images').insert({
          users_id: userId,
          url: s3Url,
        });

        if (error) {
          console.error(`   ❌ Supabase insert error:`, error);
          continue;
        }
        console.log(`   ✅ Saved to Supabase`);

        uploadedUrls.push(s3Url);
      } catch (error) {
        console.error(`   ❌ Failed to upload image: ${error.message}`);
        continue;
      }
    }

    console.log(`\n🎉 [Profile Images] Complete!`);
    console.log(
      `   Successfully uploaded: ${uploadedUrls.length}/${imageUrls.length}`,
    );

    return uploadedUrls;
  }

  async syncIG(query: any, userId: string) {
    console.log('retrieve IG called', query?.usrname);
    const usrId = query?.usrname;
    const TOKEN = process.env.APIFY_TOKEN;
    const response = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${TOKEN}&wait=60`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directUrls: [`https://www.instagram.com/${usrId}/`],
          resultsLimit: 10,
        }),
      },
    );

    const data = await response.json();
    console.log(data);

    // Extract all image URLs from posts and upload to S3
    const allImageUrls = data.flatMap((post: any) => post.images || []);

    let uploadedUrls: string[] = [];
    if (allImageUrls.length > 0 && userId) {
      uploadedUrls = await this.uploadUserProfileImages(userId, allImageUrls);

      // Update users.is_connected = true after successful upload
      const supabase = this.supabaseService.getClient();
      const { error } = await supabase
        .from('users')
        .update({ is_connected: true })
        .eq('id', userId);

      if (error) {
        console.error('❌ Failed to update is_connected:', error);
      } else {
        console.log('✅ Updated users.is_connected = true');
      }

      // Write IG username to instagram_accounts
      const { error: igError } = await supabase
        .from('instagram_accounts')
        .upsert({ id: userId, account: usrId }, { onConflict: 'id' });

      if (igError) {
        console.error('❌ Failed to save IG username:', igError);
      } else {
        console.log('✅ Saved IG username:', usrId);
      }
    }

    // Fire-and-forget Nova analysis — don't block the response
    if (uploadedUrls.length) {
      this.analyzePreferenceWithNova(userId, uploadedUrls).catch((err) =>
        console.error('analyzePreferenceWithNova failed:', err),
      );
      this.generateImageRecommendations(userId, uploadedUrls)
        .then(() => this.embedAndStoreRecommendations(userId))
        .catch((err) =>
          console.error('generateImageRecommendations failed:', err),
        );
    }

    return {
      success: true,
      message: 'Images uploaded successfully',
      count: uploadedUrls.length,
    };
  }

  async getUserProfileImages(
    userId: string,
  ): Promise<{ url: string; nice_words?: string }[]> {
    console.log('retrieve usr all img✅🧑‍🎓');
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase.rpc('random_profile_images', {
      p_user_id: userId,
    });
    if (error) {
      throw new Error(error.message);
    }
    console.log(data);
    return (data ?? []).map((row: { url: string; nice_words?: string }) => ({
      url: row.url,
      nice_words: row.nice_words,
    }));
  }

  async analyzePreferenceWithNova(userId: string, imageUrls?: string[]) {
    let urls: string[];
    if (imageUrls?.length) {
      urls = imageUrls;
    } else {
      const imageEntries = await this.getUserProfileImages(userId);
      urls = imageEntries.map((entry) => entry.url);
    }
    if (!urls.length) return { preferences: null, message: 'No images found' };

    const selectedUrls = urls.slice(0, 10);

    // Download images and build content blocks with labeled indices
    const imageContents: any[] = [];
    for (let i = 0; i < selectedUrls.length; i++) {
      const buf = await this.downloadImage(selectedUrls[i]);
      imageContents.push(
        { text: `[Image ${i}] url: ${selectedUrls[i]}` },
        {
          image: {
            format: 'jpeg' as const,
            source: { bytes: buf.toString('base64') },
          },
        },
      );
    }

    const prompt = `You are an expert fashion analyst. Analyze the user's photos and return a single JSON object.

RULES:
- Pick exactly ONE value from each category that BEST describes this user overall.
- For each image, write a 1-2 sentence summary focused on the outfit and occasion.
- Pick exactly ONE image as "is_featured": true — the photo that shows the most of the user's body (full-body or near-full-body) and would work best as a reference for virtual try-on. All others must be false.
- Respond ONLY with valid JSON. No markdown, no explanation.

AESTHETIC_ARCHETYPE (pick one):
minimal, classic_polished, quiet_luxury, romantic_feminine, bohemian, preppy, streetwear, sporty, scandi, edgy, vintage_retro, eclectic_maximalist

LIFESTYLE_OCCASION (pick one):
everyday_casual, work_office, date_night, cocktail_party, wedding_guest, vacation_resort, brunch_social, festival_event, active_outdoor, formal_event

COLOR_PATTERN_AFFINITY (pick one):
neutral, monochrome, earthy, pastel, jewel_toned, vivid_bright, solid_minimal, stripe_check_geometric, floral_botanical, animal_print

REQUIRED JSON SCHEMA:
{
  "aesthetic_archetype": "<one value from above>",
  "lifestyle_occasion": "<one value from above>",
  "color_pattern_affinity": "<one value from above>",
  "images": [
    {
      "url": "<the image url>",
      "short_summary": "<1-2 sentence outfit & occasion description>",
      "is_featured": <true for exactly one image, false for all others>
    }
  ]
}`;

    const body = {
      messages: [
        {
          role: 'user',
          content: [...imageContents, { text: prompt }],
        },
      ],
      inferenceConfig: {
        maxTokens: 2048,
        temperature: 0.2,
      },
    };

    const command = new InvokeModelCommand({
      modelId: 'amazon.nova-pro-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    });

    const response = await this.bedrockClient.send(command);
    const raw = JSON.parse(new TextDecoder().decode(response.body));
    const text = raw?.output?.message?.content?.[0]?.text ?? '';

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error('Nova returned non-JSON:', text);
      return { raw: text };
    }

    // Write to DB
    const supabase = this.supabaseService.getClient();

    // 1. Upsert users_profile
    const { error: profileError } = await supabase.from('users_profile').upsert(
      {
        id: userId,
        aesthetic_archetype: parsed.aesthetic_archetype,
        lifestyle_occasion: parsed.lifestyle_occasion,
        color_pattern_affinity: parsed.color_pattern_affinity,
      },
      { onConflict: 'id' },
    );
    if (profileError) {
      console.error('Failed to upsert users_profile:', profileError);
    }

    // 2. Update each users_profile_images row
    if (Array.isArray(parsed.images)) {
      for (const img of parsed.images) {
        const { error: imgError } = await supabase
          .from('users_profile_images')
          .update({
            short_summary: img.short_summary,
            is_featured: img.is_featured ?? false,
          })
          .eq('users_id', userId)
          .eq('url', img.url);

        if (imgError) {
          console.error(`Failed to update image ${img.url}:`, imgError);
        }
      }
    }

    return parsed;
  }

  /**
   * For each user image, ask Nova Pro to generate:
   *  - recommendation: descriptive apparel text (for later embedding + vector search)
   *  - nice_words: a fun catch-phrase / compliment
   * Images are batched (5 per request) to stay within Nova Pro's context window.
   */
  async generateImageRecommendations(userId: string, imageUrls?: string[]) {
    const supabase = this.supabaseService.getClient();

    // 1. Resolve image list — use provided URLs or fetch from DB
    let imageList: { url: string }[];
    if (imageUrls?.length) {
      imageList = imageUrls.map((url) => ({ url }));
    } else {
      const { data, error } = await supabase
        .from('users_profile_images')
        .select('url')
        .eq('users_id', userId);
      if (error) throw new Error(error.message);
      imageList = data ?? [];
    }

    if (!imageList.length) return { count: 0, message: 'No images found' };

    const BATCH_SIZE = 5;

    // Split into chunks up front
    const batches: { url: string }[][] = [];
    for (let i = 0; i < imageList.length; i += BATCH_SIZE) {
      batches.push(imageList.slice(i, i + BATCH_SIZE));
    }

    const prompt = `You are a witty, warm fashion stylist and personal shopper.

For each image, produce THREE things:

1. "nice_words" — a short, fun catch-phrase (1-2 sentences) that compliments the person or scene and ties into a fashion vibe. Be creative, playful, and encouraging. If the photo isn't about fashion (landscape, food, pets, etc.), still connect it to a style suggestion in a fun way.

2. "recommendation" — a short description of apparel and accessories that would suit this person or complement this scene. Be specific about garment types, colors, fabrics, styles, and occasions. This text will be used for semantic search later, so be descriptive with fashion vocabulary — mention silhouettes, materials, color palettes, vibes, and occasions. It should be LESS THAN 70 characters.

3. "reason" — a very short, punchy phrase (10-35 characters STRICTLY) explaining WHY you picked this recommendation for this person/scene. Connect the user's vibe, mood, or setting directly to the suggested style. Make it feel personal — not generic. Think of it as a tiny headline the user sees above their recommendations.

Examples of the tone and detail expected:

Photo of a park on a sunny day:
  nice_words: "Nice sunny day! Guess not as sunny as you are though."
  recommendation: "A spring-toned linen blouse in soft peach or lavender, paired with high-waisted cotton shorts and woven espadrilles."
  reason: "Sun-kissed park vibes"

Person in a casual outfit at a coffee shop:
  nice_words: "Coffee and good vibes — your aesthetic is effortlessly cool."
  recommendation: "Relaxed-fit camel crewneck sweater layered over a white collared shirt, dark wash straight-leg jeans, and clean white sneakers."
  reason: "Your cozy café energy"

Person at a beach:
  nice_words: "Making waves and looking like the main character."
  recommendation: "Breezy oversized linen shirt in ivory left unbuttoned over a fitted ribbed tank, with relaxed drawstring trousers."
  reason: "Coastal main character"

Person posing by a Christmas tree in a girly outfit:
  nice_words: "Tis the season to slay!"
  recommendation: "Soft pink satin blouse with pearl buttons, a pleated midi skirt in blush, and pointed-toe kitten heels."
  reason: "Princess in pink for Xmas"

Respond ONLY with valid JSON. No markdown fences, no extra text.

{
  "images": [
    {
      "url": "<the url from the image label>",
      "nice_words": "<catch phrase>",
      "recommendation": "<apparel recommendation>",
      "reason": "<10-35 char why phrase>"
    }
  ]
}`;

    // Process all batches in parallel
    console.log(
      `🧠 [Nova] Sending ${batches.length} batch(es) in parallel (${imageList.length} images total)...`,
    );

    const batchResults = await Promise.all(
      batches.map(async (batch, batchIndex) => {
        // Download images and build content blocks
        const imageContents: any[] = [];
        for (let j = 0; j < batch.length; j++) {
          const buf = await this.downloadImage(batch[j].url);
          imageContents.push(
            { text: `[Image ${j}] url: ${batch[j].url}` },
            {
              image: {
                format: 'jpeg' as const,
                source: { bytes: buf.toString('base64') },
              },
            },
          );
        }

        const body = {
          messages: [
            {
              role: 'user',
              content: [...imageContents, { text: prompt }],
            },
          ],
          inferenceConfig: {
            maxTokens: 2048,
            temperature: 0.7,
          },
        };

        const command = new InvokeModelCommand({
          modelId: 'amazon.nova-pro-v1:0',
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(body),
        });

        console.log(
          `🧠 [Nova] Batch ${batchIndex + 1}/${batches.length} (${batch.length} images) sent`,
        );

        const response = await this.bedrockClient.send(command);
        const raw = JSON.parse(new TextDecoder().decode(response.body));
        const text = raw?.output?.message?.content?.[0]?.text ?? '';

        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          console.error(
            `Nova returned non-JSON for batch ${batchIndex + 1}:`,
            text,
          );
          return [];
        }

        // Write each result to DB
        const saved: any[] = [];
        if (Array.isArray(parsed.images)) {
          for (const img of parsed.images) {
            const { error: updateError } = await supabase
              .from('users_profile_images')
              .update({
                recommendation: img.recommendation,
                nice_words: img.nice_words,
                reason: img.reason,
              })
              .eq('users_id', userId)
              .eq('url', img.url);

            if (updateError) {
              console.error(`Failed to update image ${img.url}:`, updateError);
            } else {
              saved.push(img);
            }
          }
        }
        return saved;
      }),
    );

    const results = batchResults.flat();
    console.log(
      `✅ [Nova] Done. Updated ${results.length}/${imageList.length} images.`,
    );
    return { count: results.length, images: results };
  }

  private async embedAndStoreRecommendations(userId: string) {
    const supabase = this.supabaseService.getClient();
    const { data: images, error } = await supabase
      .from('users_profile_images')
      .select('url, recommendation')
      .eq('users_id', userId)
      .not('recommendation', 'is', null);

    if (error || !images?.length) return;

    const embedUrl = process.env.RUNPOD_URL_EMBED;
    const apiKey = process.env.RUNPOD_API_KEY;
    if (!embedUrl || !apiKey) {
      console.error('❌ Missing RUNPOD_URL_EMBED or RUNPOD_API_KEY');
      return;
    }

    for (const img of images) {
      try {
        const res = await fetch(embedUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: img.recommendation }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) continue;
        const { embedding } = await res.json();

        await supabase
          .from('users_profile_images')
          .update({ recommendation_embedding: embedding })
          .eq('users_id', userId)
          .eq('url', img.url);

        console.log(`✅ Embedded recommendation for ${img.url}`);
      } catch (err: any) {
        console.error(`Embed failed for ${img.url}: ${err.message}`);
      }
    }
  }

  async history() {
    const exampleHistory = [
      {
        id: '8a9a5db2c1feba2be7564897490e4f6f724dd0e9',
        score: 24.553026,
        description:
          "There's nothing like bold hemlines and a soft touch. Featuring a deep V neckline, padded shoulders and ruching above a thigh-high front slit, our Love Sex Magic Velvet Dress is way too sexy to stay in the closet.Available in Wine and Hunter Green Deep V Thigh High Front Slit Shoulder Pads Ruching Detail Maxi Length Self 93% Polyester 7% Spandex Imported Available In Plus Sizes California Proposition 65WARNING: Cancer and Reproductive Harm - www.P65Warnings.ca.gov.",
        image_urls: [
          'https://cdn.shopify.com/s/files/1/0293/9277/products/Fashion_Nova_09-26-17-274.jpg?v=1571438195',
          'https://cdn.shopify.com/s/files/1/0293/9277/products/Fashion_Nova_09-26-17-278.jpg?v=1571438195',
          'https://cdn.shopify.com/s/files/1/0293/9277/products/Fashion_Nova_09-26-17-286.jpg?v=1571438195',
          'https://cdn.shopify.com/s/files/1/0293/9277/products/Fashion_Nova_09-26-17-282.jpg?v=1571438195',
        ],
        handle: 'love-sex-magic-velvet-dress-hunter',
        title: 'Love Sex Magic Velvet Dress - Hunter',
        price_min: 15.98,
        featured_image: {
          altText: null,
          width: 2523,
          url: 'https://cdn.shopify.com/s/files/1/0293/9277/products/Fashion_Nova_09-26-17-274.jpg?v=1571438195',
          height: 3784,
        },
        product_gid: 'gid://shopify/Product/10019894353',
        url: 'https://www.fashionnova.com/products/love-sex-magic-velvet-dress-hunter',
        tags: [
          '60sale',
          'bottom_length:Maxi',
          'category:Dresses',
          'category_es:Vestidos',
          'color:Hunter',
          'color_fam:Green',
          'ColorFam-Green',
          'default_collection_id:180828100',
          'detail:High Slit',
          'detail:Slit',
          'detail_es:Abertura',
          'detail_es:Abertura Alta',
          'Dresses',
          'fabric:Velvet',
          'fabric_es:Terciopelo',
          'figure:Plus',
          'final sale',
          'Formal',
          'Glam',
          'includedinpromo',
          'JRMODELHEIGHT-FT-5-IN-3',
          'Last Chance',
          'Maxi',
          'neckline:V-Neck',
          'neckline_es:Cuello En V',
          'occasion:Prom & Homecoming',
          'occasion_es:Baile De Graduación',
          'Plus',
          'print:Solid',
          'print_es:Estampado Sólido',
          'prop65-true',
          'Sale',
          'sleeve:Long Sleeve',
          'sleeve_es:Manga Larga',
          'WOMENS',
          'YGroup_AR082016',
        ],
        updated_at: '2026-02-10T23:00:42Z',
        indexed_at: '2026-02-18T09:04:05Z',
        store_domain: 'www.fashionnova.com',
        currency: 'USD',
        price_max: 15.98,
      },
      {
        id: '9e763f18ec7134e64d2f0dbf27dd14051ad364d9',
        score: 24.553026,
        description:
          'you need some constructive criticism. This baby tee has cap sleeves, a cropped fit, and text graphics printed across the chest.',
        image_urls: [
          'https://cdn.shopify.com/s/files/1/0634/6335/8721/products/hPYZngHtUC7dvOECoMeFhTjyLFOFslJp-24.jpg?v=1682744248',
          'https://cdn.shopify.com/s/files/1/0634/6335/8721/products/3lL0PXrwOXcGeGUYQwT6M0ThqbacA9ps-24.jpg?v=1682744249',
          'https://cdn.shopify.com/s/files/1/0634/6335/8721/products/rNzj8huyVVhg2BjZkfcQZruQbkuSMs62-24.jpg?v=1651783506',
          'https://cdn.shopify.com/s/files/1/0634/6335/8721/products/Cdjboigx1GE1pHFqgdT3TRnA7HUMCYC9-24.jpg?v=1651783506',
        ],
        handle: 'the-sex-was-bad-graphic-tee',
        title: 'The Sex Was Bad Graphic Tee',
        price_min: 50,
        featured_image: {
          altText: 'base',
          width: 843,
          url: 'https://cdn.shopify.com/s/files/1/0634/6335/8721/products/hPYZngHtUC7dvOECoMeFhTjyLFOFslJp-24.jpg?v=1682744248',
          height: 1200,
        },
        product_gid: 'gid://shopify/Product/7640280236289',
        url: 'https://www.dollskill.com/products/the-sex-was-bad-graphic-tee',
        tags: [
          '[color:yellow]color_family:yellow--7640280236289',
          'algolia-ignore',
          'amazon_color:YELLOW',
          'category:Clothing',
          'color:YELLOW',
          'digital',
          'discounteligible',
          'exclude_rebuy',
          'fullprice',
          'launch_date:2/21/2022',
          'launchdate:2/21/2022',
          'main:efe0bd2c212eceec598c42a15b8cd07f',
          'micro:988f0f46dc0a1b862f17028987d2d399',
          'microcategory:Graphic T-Shirt',
          'parentId:259869',
          'regprice',
          'sale:pinksale',
          'sub2:044914add4ae99b6f7e510443478f9a8',
          'sub:11087d84f70335d1fec3aa9e72c8b1d5',
          'subcategory2:Graphic Tees',
          'subcategory:Tops',
          'trend:None',
          'YCRF_clothing_tops',
        ],
        updated_at: '2026-02-13T23:20:43Z',
        indexed_at: '2026-02-18T09:37:29Z',
        store_domain: 'www.dollskill.com',
        currency: 'USD',
        price_max: 50,
      },
      {
        id: 'ecebac762bcedda9971b7ac75f48f1373598270e',
        score: 24.553026,
        description:
          "Be dazzled with the latest hair craze, a sparkle logo clip. This accessory is one to top all your outfits off with it's silver diamante sex logo. The 90's hair slide has made a bold return!",
        image_urls: [
          'https://cdn.shopify.com/s/files/1/1444/3082/products/SOLINA-UNITARD-FIRE-MESH-21741.jpg?v=1571440766',
        ],
        handle: 'hair-clip-w-sex-logo',
        title: 'Hair Clip with Silver Sex Logo',
        price_min: 6,
        featured_image: {
          altText: 'Image of Hair Clip with Silver Sex Logo',
          width: 870,
          url: 'https://cdn.shopify.com/s/files/1/1444/3082/products/SOLINA-UNITARD-FIRE-MESH-21741.jpg?v=1571440766',
          height: 1100,
        },
        product_gid: 'gid://shopify/Product/2471674314865',
        url: 'https://www.motelrocks.com/products/hair-clip-w-sex-logo',
        tags: [
          'accessory',
          'diamante',
          'diamond',
          'festival',
          'festival wear',
          'grip',
          'hair accessory',
          'HAIR CLIP W/ SEX LOGO',
          'hair grip',
          'hair slide',
          'live',
          'logo hair slide',
          'ONE SIZE',
          'related: hair-clip-w-girls-logo',
          'related: hair-clip-w-heaven-logo',
          'related: hair-clip-w-smiley-face',
          'SEARCHANISE_IGNORE',
          'sex slide',
          'silver',
          'slide',
          'sparkle',
        ],
        updated_at: '2025-12-22T13:20:30Z',
        indexed_at: '2026-02-18T09:25:48Z',
        store_domain: 'motelrocks.com',
        currency: 'GBP',
        price_max: 6,
      },
      {
        id: '3664f56e99f948a6e1a42487a71125d0d4b58c1f',
        score: 24.553026,
        description:
          'switching the positions for you! These dice glow in the dark and have graphics of sex positions.',
        image_urls: [
          'https://cdn.shopify.com/s/files/1/0634/6335/8721/products/ua8cvyqhCRmgO5YZiLXDi5R90h0bmEzH-24.jpg?v=1682864955',
          'https://cdn.shopify.com/s/files/1/0634/6335/8721/products/iwh565q8CpXE7KKImGpCv8W9QP9aAOoP-24.jpg?v=1682864956',
        ],
        handle: 'glow-in-the-dark-sex-dice',
        title: 'Glow In The Dark Sex Dice',
        price_min: 10,
        featured_image: {
          altText: 'base',
          width: 843,
          url: 'https://cdn.shopify.com/s/files/1/0634/6335/8721/products/ua8cvyqhCRmgO5YZiLXDi5R90h0bmEzH-24.jpg?v=1682864955',
          height: 1200,
        },
        product_gid: 'gid://shopify/Product/7671777755393',
        url: 'https://www.dollskill.com/products/glow-in-the-dark-sex-dice',
        tags: [
          '[color:rainbow]color_family:rainbow--7671777755393',
          'algolia-ignore',
          'amazon_color:MULTI',
          'bq1',
          'category:Accessories',
          'color:MULTI',
          'color:RAINBOW',
          'digital',
          'discounteligible',
          'exclude_rebuy',
          'fullprice',
          'launch_date:1/5/2021',
          'launchdate:1/5/2021',
          'main:98edb85b00d9527ad5acebe451b3fae6',
          'parentId:213188',
          'SALESUMMER',
          'sub2:66d0af2d5da0109dc2aae67829f7d4d4',
          'sub:7b3bac443b079338bdfc69e461b83cdc',
          'subcategory2:Toys',
          'subcategory:Other Shit',
          'trend:VDay 2021',
          'YCRF_accessories',
        ],
        updated_at: '2026-02-14T07:24:51Z',
        indexed_at: '2026-02-18T09:42:04Z',
        store_domain: 'www.dollskill.com',
        currency: 'USD',
        price_max: 10,
      },
      {
        id: 'f544e2339992e2ee4eeb172eed0ebb65b700d41a',
        score: 22.956072,
        description: 'Crop top product description',
        image_urls: [
          'https://cdn.shopify.com/s/files/1/0581/8859/5252/files/womens-crop-top-pale-pink-front-66d874b83db2e.jpg?v=1725461709',
          'https://cdn.shopify.com/s/files/1/0581/8859/5252/files/womens-crop-top-hazy-pink-front-66d874b83f800.jpg?v=1725461711',
          'https://cdn.shopify.com/s/files/1/0581/8859/5252/files/womens-crop-top-bubblegum-front-66d874b83fa70.jpg?v=1725461713',
          'https://cdn.shopify.com/s/files/1/0581/8859/5252/files/womens-crop-top-athletic-heather-front-66d874b83ff2a.jpg?v=1725461715',
        ],
        handle: 'apple-orchards-and-lesbian-sex-crop-top',
        title: 'Apple Orchards and Lesbian Sex crop top',
        price_min: 29.95,
        featured_image: {
          altText: null,
          width: 2000,
          url: 'https://cdn.shopify.com/s/files/1/0581/8859/5252/files/womens-crop-top-pale-pink-front-66d874b83db2e.jpg?v=1725461709',
          height: 2000,
        },
        product_gid: 'gid://shopify/Product/7614295638068',
        url: 'https://gotfunnymerch.com/products/apple-orchards-and-lesbian-sex-crop-top',
        tags: ['Crop Top', 'Halloween', 'Pride'],
        updated_at: '2026-01-13T05:03:27Z',
        indexed_at: '2026-02-18T09:22:10Z',
        store_domain: 'gotfunnymerch.com',
        currency: 'USD',
        price_max: 29.95,
      },
      {
        id: 'e41324b5e3237538faec2ef1b8bd082ae87ac0ae',
        score: 22.956072,
        description:
          'A sturdy and warm sweatshirt bound to keep you warm in the colder months. A pre-shrunk, classic fit sweater that’s made with air-jet spun yarn for a soft feel. • 50% cotton, 50% polyester • Pre-shrunk • Classic fit • 1x1 athletic rib knit collar with spandex • Air-jet spun yarn with a soft feel • Double-needle stitched collar, shoulders, armholes, cuffs, and hemSize guide LENGTH (inches) WIDTH (inches) S 27 20 M 28 22 L 29 24 XL 30 26 2XL 31 28 3XL 32 30 4XL 33 32 5XL 34 34 LENGTH (cm) WIDTH (cm) S 68.6 50.8 M 71.1 55.9 L 73.7 61 XL 76.2 66 2XL 78.7 71.1 3XL 81.3 76.2 4XL 83.8 81.3 5XL 86.4 86.4',
        image_urls: [
          'https://cdn.shopify.com/s/files/1/0581/8859/5252/files/unisex-crew-neck-sweatshirt-sand-front-66d8751c7eba1.jpg?v=1725461807',
          'https://cdn.shopify.com/s/files/1/0581/8859/5252/files/unisex-crew-neck-sweatshirt-light-blue-front-66d8751c814c3.jpg?v=1725461809',
          'https://cdn.shopify.com/s/files/1/0581/8859/5252/files/unisex-crew-neck-sweatshirt-sport-grey-front-66d8751c81e51.jpg?v=1725461811',
          'https://cdn.shopify.com/s/files/1/0581/8859/5252/files/unisex-crew-neck-sweatshirt-light-pink-front-66d8751c83621.jpg?v=1725461813',
        ],
        handle: 'apple-orchards-and-lesbian-sex-unisex-sweatshirt',
        title: 'Apple Orchards and Lesbian Sex Unisex Sweatshirt',
        price_min: 37.95,
        featured_image: {
          altText: null,
          width: 2000,
          url: 'https://cdn.shopify.com/s/files/1/0581/8859/5252/files/unisex-crew-neck-sweatshirt-sand-front-66d8751c7eba1.jpg?v=1725461807',
          height: 2000,
        },
        product_gid: 'gid://shopify/Product/7614295867444',
        url: 'https://gotfunnymerch.com/products/apple-orchards-and-lesbian-sex-unisex-sweatshirt',
        tags: ['Halloween', 'Pride', 'Sweater', 'Thanksgiving'],
        updated_at: '2025-12-28T12:08:07Z',
        indexed_at: '2026-02-18T09:22:10Z',
        store_domain: 'gotfunnymerch.com',
        currency: 'USD',
        price_max: 37.95,
      },
    ];
    try {
      return exampleHistory;
    } catch (err: any) {
      // SQLite
      if (err?.code === 'SQLITE_CONSTRAINT') {
        throw new ConflictException('Email already exists');
      }
      // Postgres
      if (err?.code === '23505') {
        throw new ConflictException('Email already exists');
      }
      // MySQL
      if (err?.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Email already exists');
      }

      throw err;
    }
  }
}
