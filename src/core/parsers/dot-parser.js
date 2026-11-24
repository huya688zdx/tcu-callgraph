import fs from 'node:fs';
import path from 'node:path';
import { modelFromDot, parseDot } from '../dot.js';
import { decodeSource } from '../source-files.js';
import { emptyDataflow } from './ir.js';

export const dotParser = {
  id: 'dot',
  name: 'Graphviz DOT',
  available: () => ({ ok: true }),
  parse: (target) => ({
    ...modelFromDot(parseDot(decodeSource(fs.readFileSync(target))), path.basename(target)),
    _df: emptyDataflow(),
  }),
};
