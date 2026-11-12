import { handleBookshop } from '../../makers/handler.mjs';

export async function onRequest(context: any) {
  return handleBookshop(context);
}
