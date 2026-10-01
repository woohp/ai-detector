// Loads public/models/<name> through Transformers.js (Node build) and prints scores for the
// same samples as export.py, to confirm the shipped files work outside Python.
//   node model/smoke.mjs vanguard
import { AutoModelForSequenceClassification, AutoTokenizer, env } from '@huggingface/transformers';

const name = process.argv[2] ?? 'vanguard';
const head = name === 'vanguard' ? 'sigmoid' : 'softmax';

env.allowRemoteModels = false;
env.localModelPath = new URL('../public/models/', import.meta.url).pathname;

const SAMPLES = [
  'The bridge was closed for three weeks in 1987 after a barge struck one of its piers during a storm.',
  "honestly i didn't expect the ending at all, my sister cried and i just sat there like ok what",
  "In today's fast-paced world, effective communication is more important than ever. By leveraging " +
    'cutting-edge tools and fostering a culture of collaboration, organizations can unlock new levels of productivity.',
  'Certainly! Here is a concise overview of the key benefits of renewable energy: it reduces greenhouse gas ' +
    'emissions, enhances energy security, and creates sustainable economic opportunities.',
];

const tokenizer = await AutoTokenizer.from_pretrained(name);
const model = await AutoModelForSequenceClassification.from_pretrained(name, { dtype: 'fp16' });

for (const text of SAMPLES) {
  const t0 = performance.now();
  const { logits } = await model(tokenizer(text, { truncation: true, max_length: 512 }));
  const v = Array.from(logits.data);
  const score = head === 'sigmoid' ? 1 / (1 + Math.exp(-v[0])) : Math.exp(v[1]) / (Math.exp(v[0]) + Math.exp(v[1]));
  console.log(`${text.slice(0, 48).padEnd(50)} ${score.toFixed(4)}  (${Math.round(performance.now() - t0)} ms)`);
}
