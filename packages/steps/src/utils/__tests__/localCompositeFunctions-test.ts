import { isCompositeFunctionPath } from '../localCompositeFunctions';

describe(isCompositeFunctionPath, () => {
  it('recognizes relative paths as local composite function paths', () => {
    expect(isCompositeFunctionPath('./.eas/functions/setup')).toBe(true);
    expect(isCompositeFunctionPath('../../shared/functions/setup')).toBe(true);
    expect(isCompositeFunctionPath('  ./.eas/functions/setup/  ')).toBe(true);
  });

  it('rejects function ids and absolute or backslash-prefixed paths', () => {
    expect(isCompositeFunctionPath('eas/build')).toBe(false);
    expect(isCompositeFunctionPath('/functions/setup')).toBe(false);
    expect(isCompositeFunctionPath('..\\functions\\setup')).toBe(false);
  });
});
