import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceUsage } from '../src/repositories/usage.ts';

test('source uses respect symbols rather than comments, strings or shadowed names', () => {
  const raw = `import { calculate as compute } from './money';
import { unused } from './unused';
export function render() { return compute(10); }
function shadow(compute: (n: number) => number) { return compute(5); }
// unused(); compute();
const text = 'unused()';
render();`;
  const usage = sourceUsage(raw, 'view.ts');
  assert.deepEqual(usage.imports.map(use => [use.name, use.importedName, use.module, use.startLine]), [['compute', 'calculate', './money', 3]]);
  assert.deepEqual(usage.definitions.find(definition => definition.name === 'render')!.uses.map(use => use.startLine), [7]);
  assert.deepEqual(usage.definitions.find(definition => definition.name === 'render')!.exportNames, ['render']);
  assert.deepEqual(usage.definitions.find(definition => definition.name === 'shadow')!.exportNames, []);
});

test('source uses track named exports, default exports, namespace calls and JSX bindings', () => {
  const raw = `import * as money from './money';
import Panel from './panel';
function increase() { return money.add(1); }
const unused = () => 2;
export { increase as raise };
export default increase;
const view = <Panel onClick={increase} />;`;
  const usage = sourceUsage(raw, 'controls.tsx');
  assert.deepEqual(usage.imports.map(use => [use.kind, use.importedName]), [['call', 'add'], ['render', 'default']]);
  assert.deepEqual(usage.definitions.find(definition => definition.name === 'increase')!.exportNames.sort(), ['default', 'raise']);
  assert.deepEqual(usage.definitions.find(definition => definition.name === 'increase')!.uses.map(use => use.kind), ['event']);
  assert.deepEqual(usage.definitions.find(definition => definition.name === 'unused')!.uses, []);
  for (const use of usage.imports) assert.equal(raw.slice(use.startOffset, use.endOffset), use.name);
  assert.deepEqual(sourceUsage('export const broken = <button', 'broken.tsx'), { definitions: [], imports: [] });
});
