import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RedisStore } from 'connect-redis';
import session from 'express-session';
import { createClient } from 'redis';
import cookieParser from 'cookie-parser';
import { ValidationPipe } from '@nestjs/common';
import * as dotenv from 'dotenv';
dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // CORS: allow the frontend origin (Vercel in prod, localhost in dev)
  const allowedOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',')
    : ['http://localhost:3000'];

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.use(cookieParser());

  // Connect Redis
  const redisClient = createClient({
    url: process.env.REDIS_URL,
  });
  redisClient.on('error', (err) => console.error('Redis error:', err));
  await redisClient.connect();

  const store = new RedisStore({
    client: redisClient,
    prefix: 'sess:',
  });

  app.use(
    session({
      name: 'sid',
      store,
      secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
      resave: false,
      saveUninitialized: false,
      rolling: true,
      proxy: isProduction, // trust the reverse proxy (Fly.io)
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction, // HTTPS only in production
        maxAge: 1000 * 60 * 60 * 24, // 1 day
      },
    }),
  );

  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port, '0.0.0.0'); // bind to all interfaces for containers
  console.log(`Server running on port ${port} (${isProduction ? 'production' : 'development'})`);
}
bootstrap();
