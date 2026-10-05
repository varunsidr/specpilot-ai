export type Product = { id: string; name: string; price: number };
export const products: Product[] = [
  { id: 'shirt-1', name: 'Cotton shirt', price: 799 },
  { id: 'jacket-1', name: 'Denim jacket', price: 1999 },
];
// Demo application context: maximum-price filtering is not implemented yet.
export function getProducts(): Product[] { return products; }
