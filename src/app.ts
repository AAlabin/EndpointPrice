import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import axios from 'axios';
import { createClient } from 'redis';

const app = new Hono();
const redis = createClient();

redis.connect().catch(console.error);

const API_URLS = [
  'https://api.skinport.com/v1/items?app_id=730&currency=EUR&tradable=true',
  'https://api.skinport.com/v1/items?app_id=730&currency=EUR&tradable=false'
];

const CACHE_KEY = 'skinport_items';
const CACHE_TTL = 300; // 5 минут

type Item = {
  market_hash_name: string;
  min_price: number;
};

type MergedItem = {
  market_hash_name: string;
  tradable_min_price: number | null;
  no_tradable_min_price: number | null;
};

app.get('/items', async (c) => {
  try {
    const cachedData = await redis.get(CACHE_KEY);
    if (cachedData) {
      return c.json(JSON.parse(cachedData));
    }

    const responses = await Promise.all(
      API_URLS.map(url => axios.get<Item[]>(url, { headers: { 'Accept-Encoding': 'br' } }))
    );

    if (!responses[0] || !responses[1]) {
      throw new Error('Ответ API не определен');
    }

    const [tradableResponse, noTradableResponse] = responses;
    const tradableItems = tradableResponse.data || [];
    const noTradableItems = noTradableResponse.data || [];

    const mergedItems = new Map<string, MergedItem>();

    for (const item of tradableItems) {
      mergedItems.set(item.market_hash_name, {
        market_hash_name: item.market_hash_name,
        tradable_min_price: item.min_price,
        no_tradable_min_price: null
      });
    }

    for (const item of noTradableItems) {
      if (mergedItems.has(item.market_hash_name)) {
        mergedItems.get(item.market_hash_name)!.no_tradable_min_price = item.min_price;
      } else {
        mergedItems.set(item.market_hash_name, {
          market_hash_name: item.market_hash_name,
          tradable_min_price: null,
          no_tradable_min_price: item.min_price
        });
      }
    }

    const result = Array.from(mergedItems.values());
    await redis.setEx(CACHE_KEY, CACHE_TTL, JSON.stringify(result));

    return c.json(result);
  } catch (error) {
    console.error('Ошибка при загрузке элементов:', error);
    return c.json({ error: 'Не удалось получить элементы' }, 500);
  }
});

serve({
  fetch: app.fetch,
  port: 3000,
});

console.log('Сервер запущен по адресу: http://localhost:3000/items');

export default app;
