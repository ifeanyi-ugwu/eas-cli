import {
  CONNECTION_HOST_REGEX,
  CONNECTION_SECRET_REGEX,
  parseSshArgv,
  resolveSshConnectStatus,
} from '../ssh';

describe(parseSshArgv, () => {
  it('takes the first token as the resource id and the rest as the passthrough command', () => {
    expect(parseSshArgv(['job-id', 'ls', '-la'])).toEqual({
      showConnect: false,
      resourceId: 'job-id',
      command: ['ls', '-la'],
    });
  });

  it('detects --show-connect before the id and strips it', () => {
    expect(parseSshArgv(['--show-connect', 'job-id'])).toEqual({
      showConnect: true,
      resourceId: 'job-id',
      command: [],
    });
  });

  it('detects --show-connect=true before the id', () => {
    expect(parseSshArgv(['--show-connect=true', 'job-id'])).toEqual({
      showConnect: true,
      resourceId: 'job-id',
      command: [],
    });
  });

  it('leaves --show-connect after the id in the passthrough command', () => {
    expect(parseSshArgv(['job-id', '--show-connect'])).toEqual({
      showConnect: false,
      resourceId: 'job-id',
      command: ['--show-connect'],
    });
  });

  it('reports an undefined resource id when none is given', () => {
    expect(parseSshArgv([])).toEqual({ showConnect: false, resourceId: undefined, command: [] });
    expect(parseSshArgv(['--show-connect'])).toEqual({
      showConnect: true,
      resourceId: undefined,
      command: [],
    });
  });
});

describe(resolveSshConnectStatus, () => {
  it('is not-enabled when there is no session', () => {
    expect(resolveSshConnectStatus(null)).toBe('not-enabled');
  });

  it('is ended when the session is closed', () => {
    expect(
      resolveSshConnectStatus({ closedAt: '2026-01-01T00:00:00Z', connectionConfig: null })
    ).toBe('ended');
  });

  it('is pending when open but no connection config has been reported yet', () => {
    expect(resolveSshConnectStatus({ closedAt: null, connectionConfig: null })).toBe('pending');
  });

  it('is ready when open with a connection config', () => {
    expect(
      resolveSshConnectStatus({
        closedAt: null,
        connectionConfig: { connectionHost: 'uptermd.upterm.dev', secret: 'tok' },
      })
    ).toBe('ready');
  });
});

describe('workflow:ssh connection validation', () => {
  describe('CONNECTION_SECRET_REGEX', () => {
    it.each(['TOKENabc123', 'sessionId:dGhpcytpcy9iYXNlNjQ9', 'a.b_c~d-e'])(
      'accepts the upterm token %s',
      token => {
        expect(CONNECTION_SECRET_REGEX.test(token)).toBe(true);
      }
    );

    it.each(['tok en', 'tok\nUser attacker', 'tok@host', 'tok"x', "tok'x", 'tok`x', ''])(
      'rejects %j so it cannot inject an ssh config directive',
      token => {
        expect(CONNECTION_SECRET_REGEX.test(token)).toBe(false);
      }
    );
  });

  describe('CONNECTION_HOST_REGEX', () => {
    it('accepts a plain hostname', () => {
      expect(CONNECTION_HOST_REGEX.test('uptermd.upterm.dev')).toBe(true);
    });

    it.each(['host name', 'host\nHostName evil', 'host@x', 'host/x', ''])('rejects %j', host => {
      expect(CONNECTION_HOST_REGEX.test(host)).toBe(false);
    });
  });
});
