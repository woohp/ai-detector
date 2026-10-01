// Dev page: open <extension origin>/bench.html. Compares WebGPU and WASM on this browser/machine.
import { DEVICE_KEY, loadModel, score, type Device } from '@/lib/detector';
import { DEFAULT_MODEL, MODELS, type ModelSpec } from '@/lib/models';

const SHORT = 'The bridge was closed for three weeks in 1987 after a barge struck one of its piers during a storm.';
const LONG = 'We missed the 8:15 train so we walked to the next station, got rained on, and ended up eating cold pizza. '.repeat(20);

// export.py's samples with PyTorch fp32 scores, to measure each device/precision's error.
const REFERENCE: [string, number][] = [
  ['The bridge was closed for three weeks in 1987 after a barge struck one of its piers during a storm.', 0.0296],
  ["honestly i didn't expect the ending at all, my sister cried and i just sat there like ok what", 0.2189],
  ["In today's fast-paced world, effective communication is more important than ever. By leveraging cutting-edge tools and fostering a culture of collaboration, organizations can unlock new levels of productivity.", 0.9999],
  ['Certainly! Here is a concise overview of the key benefits of renewable energy: it reduces greenhouse gas emissions, enhances energy security, and creates sustainable economic opportunities.', 1.0],
  ['My grandmother kept chickens until she was 91. She named every one of them after a different Supreme Court justice, which got confusing when two of them were both called Ruth.', 0.0714],
  ['We missed the 8:15 train so we walked to the next station, got rained on, and ended up eating cold pizza at the platform. Best day of the trip, weirdly.', 0.1135],
  ['Machine learning models have transformed numerous industries by enabling data-driven decision-making. However, it is crucial to consider ethical implications, such as bias and transparency, to ensure responsible deployment.', 1.0],
  ['Overall, this approach offers a robust and scalable solution that balances performance, maintainability, and user experience, making it an excellent choice for modern applications.', 1.0],
];

const info = document.querySelector<HTMLPreElement>('#info')!;
const table = document.querySelector<HTMLTableElement>('#results')!;

function log(line: string) {
  info.textContent += line + '\n';
}

function row(cells: (string | number)[], header = false) {
  const tr = table.insertRow();
  for (const c of cells) {
    const cell = document.createElement(header ? 'th' : 'td');
    cell.textContent = String(c);
    tr.append(cell);
  }
}

async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const result = await fn();
  return [result, Math.round(performance.now() - t0)];
}

async function bench(device: Device, dtype: ModelSpec['dtype']) {
  try {
    const [loaded, loadMs] = await time(() => loadModel(device, undefined, dtype));
    const [, short1] = await time(() => score(loaded, SHORT));
    const [, short2] = await time(() => score(loaded, SHORT));
    const [, long1] = await time(() => score(loaded, LONG));
    const [, long2] = await time(() => score(loaded, LONG));
    let maxErr = 0;
    for (const [text, ref] of REFERENCE) maxErr = Math.max(maxErr, Math.abs((await score(loaded, text)) - ref));
    row([`${device}/${dtype}`, loadMs, short1, short2, long1, long2, maxErr.toFixed(4)]);
    await loaded.model.dispose();
  } catch (err) {
    row([`${device}/${dtype}`, `failed: ${err instanceof Error ? err.message : err}`]);
  }
}

document.querySelector('#run')!.addEventListener('click', async () => {
  info.textContent = '';
  table.replaceChildren();
  log(`${navigator.userAgent}\ncores ${navigator.hardwareConcurrency}, crossOriginIsolated ${self.crossOriginIsolated}`);
  log(`remembered device: ${localStorage.getItem(DEVICE_KEY) ?? '(none)'}`);
  const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  const gpu = adapter?.info;
  log(gpu ? `WebGPU adapter: ${gpu.vendor} ${gpu.architecture} ${gpu.device} ${gpu.description}${gpu.isFallbackAdapter ? ' (fallback/software)' : ''}` : 'WebGPU: unavailable');
  row(['device', 'load+warm-up ms', 'short #1', 'short #2', '512 tok #1', '512 tok #2', 'max |Δ| vs PyTorch'], true);
  // ?webgpu=fp16,q8&wasm=fp16 to try other precisions (their model files must be in public/models).
  const params = new URLSearchParams(location.search);
  const dtypes = (device: Device) => (params.get(device) ?? MODELS[DEFAULT_MODEL].dtype).split(',') as ModelSpec['dtype'][];
  if (adapter) for (const dtype of dtypes('webgpu')) await bench('webgpu', dtype);
  for (const dtype of dtypes('wasm')) await bench('wasm', dtype);
  log('done');
  document.title = 'done';
});

document.querySelector('#reset')!.addEventListener('click', () => {
  localStorage.removeItem(DEVICE_KEY);
  log('device choice cleared');
});
