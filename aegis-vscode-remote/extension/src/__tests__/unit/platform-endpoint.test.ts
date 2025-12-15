import { getGrpcTargetOverrides } from '../../grpc-target';

describe('getGrpcTargetOverrides', () => {
  test.each([
    [
      'platform.aegis.example.com:443',
      { sslTargetNameOverride: 'platform.aegis.example.com', defaultAuthority: 'platform.aegis.example.com' },
    ],
    ['127.0.0.1:50051', { sslTargetNameOverride: '127.0.0.1', defaultAuthority: '127.0.0.1' }],
    ['[2607::1]:443', { sslTargetNameOverride: '2607::1', defaultAuthority: '[2607::1]' }],
    [
      'https://platform.aegis.example.com:443',
      { sslTargetNameOverride: 'platform.aegis.example.com', defaultAuthority: 'platform.aegis.example.com' },
    ],
    ['https://[2607::1]:443', { sslTargetNameOverride: '2607::1', defaultAuthority: '[2607::1]' }],
    ['2607::1', { sslTargetNameOverride: '2607::1', defaultAuthority: '[2607::1]' }],
    ['dns:///platform.aegis.example.com:443', undefined],
    ['unix:///tmp/aegis.sock', undefined],
    ['foo:bar:baz', undefined],
  ])('parses overrides from %s', (endpoint, expected) => {
    expect(getGrpcTargetOverrides(endpoint)).toEqual(expected);
  });
});
