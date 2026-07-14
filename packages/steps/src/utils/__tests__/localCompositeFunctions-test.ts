import { isCompositeFunctionPath, parseCompositeFunctionPath } from '../localCompositeFunctions';

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

describe(parseCompositeFunctionPath, () => {
  it('parses local composite function paths', () => {
    expect(parseCompositeFunctionPath('./.eas/functions/setup')).toBe('./.eas/functions/setup');
    expect(parseCompositeFunctionPath('../../shared/functions/setup')).toBe(
      '../../shared/functions/setup'
    );
  });

  it('normalizes local composite function paths', () => {
    expect(parseCompositeFunctionPath('  ./.eas/functions/setup/  ')).toBe(
      './.eas/functions/setup'
    );
  });

  it('collapses equivalent paths to the same canonical path', () => {
    expect(parseCompositeFunctionPath('././.eas/functions/setup')).toBe('./.eas/functions/setup');
    expect(parseCompositeFunctionPath('./.eas/functions/other/../setup')).toBe(
      './.eas/functions/setup'
    );
    expect(parseCompositeFunctionPath('../shared/other/../functions/setup')).toBe(
      '../shared/functions/setup'
    );
  });

  it('keeps the "./" prefix for under-root directories whose name starts with ".."', () => {
    expect(parseCompositeFunctionPath('./..functions/setup')).toBe('./..functions/setup');
  });

  it('throws for degenerate paths with no path segment', () => {
    expect(() => parseCompositeFunctionPath('./')).toThrow(
      /does not point to a composite function directory/
    );
    expect(() => parseCompositeFunctionPath('  ./  ')).toThrow(
      /does not point to a composite function directory/
    );
    expect(() => parseCompositeFunctionPath('../')).toThrow(
      /does not point to a composite function directory/
    );
    expect(() => parseCompositeFunctionPath('./..')).toThrow(
      /does not point to a composite function directory/
    );
  });

  it('throws for backslash-based paths', () => {
    expect(() => parseCompositeFunctionPath('./functions\\setup')).toThrow(
      /must not contain backslashes/
    );
  });

  it('throws for interpolated local composite function paths', () => {
    expect(() => parseCompositeFunctionPath('./.eas/functions/${{ inputs.name }}')).toThrow(
      /must not contain interpolation/
    );
  });

  it('parses local composite function paths that contain }}${{ as literal characters', () => {
    expect(parseCompositeFunctionPath('./.eas/functions/weird}}${{name')).toBe(
      './.eas/functions/weird}}${{name'
    );
  });
});
