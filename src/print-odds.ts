// Prints the market menu with exact probabilities and the odds at a given margin.
// Usage: npm run odds -- 500   (margin in basis points, 500 = 5%)
import { priceList } from './markets.ts';

const margin = Number(process.argv[2] ?? 500);
console.log(`Margin ${(margin / 100).toFixed(2)}%\n`);
console.log('market            probability   fair odds   odds   house edge');
for (const m of priceList(margin)) {
  console.log(
    `${m.id.padEnd(17)} ${(m.probability * 100).toFixed(3).padStart(8)}%   ${(1 / m.probability).toFixed(3).padStart(8)}   ${(m.oddsX100 / 100).toFixed(2).padStart(6)}   ${(m.houseEdge * 100).toFixed(2).padStart(6)}%`,
  );
}
