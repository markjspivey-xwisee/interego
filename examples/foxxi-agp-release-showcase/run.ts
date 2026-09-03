import { runShowcase } from './showcase.js';

const { report } = await runShowcase();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
