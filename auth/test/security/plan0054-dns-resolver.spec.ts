import { parseTxtRecordData, resolveTxtDnsProof } from '../../../api/ads-api/src/modules/verification/dns-proof-resolver';
import * as https from 'https';
import { EventEmitter } from 'events';

jest.mock('https', () => ({ request: jest.fn() }));

describe('PLAN-0054: Reliable DNS TXT Ownership Verification with DoH Resolvers', () => {
  const token = 'cf_verify_39c9f465df4814a6de7bc5943d3d18b1';
  const expectedRecord = `crimfig-site-verification=${token}`;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseTxtRecordData', () => {
    // Failure / Rejection cases first per JED rule
    it('rejects / returns empty for empty input', () => {
      expect(parseTxtRecordData('')).toBe('');
      expect(parseTxtRecordData(null as any)).toBe('');
    });

    it('unquotes and unescapes quotes and backslashes properly', () => {
      expect(parseTxtRecordData(`"${expectedRecord}"`)).toBe(expectedRecord);
      expect(parseTxtRecordData(`"text with \\"escaped quotes\\""`)).toBe('text with "escaped quotes"');
      expect(parseTxtRecordData(`"text with \\\\escaped backslash"`)).toBe('text with \\escaped backslash');
    });

    it('preserves unquoted raw strings without alteration', () => {
      expect(parseTxtRecordData(expectedRecord)).toBe(expectedRecord);
    });
  });

  describe('resolveTxtDnsProof Failure / Negative Cases First', () => {
    function mockDoHResponse(status: number, body: any) {
      (https.request as jest.Mock).mockImplementation((_url, _options, callback) => {
        const req: any = new EventEmitter();
        req.end = jest.fn(() => {
          const res: any = new EventEmitter();
          res.statusCode = status;
          callback(res);
          res.emit('data', Buffer.from(JSON.stringify(body)));
          res.emit('end');
        });
        return req;
      });
    }

    it('returns proof_absent when public resolvers return valid answers without the expected token', async () => {
      mockDoHResponse(200, {
        Status: 0,
        Answer: [
          { name: 'example.com', type: 16, TTL: 300, data: '"v=spf1 ~all"' },
          { name: 'example.com', type: 16, TTL: 300, data: '"unrelated-verification=12345"' },
        ],
      });

      const res = await resolveTxtDnsProof('example.com', token);
      expect(res.isVerified).toBe(false);
      expect(res.status).toBe('proof_absent');
      expect(res.errorMessage).toContain('Exact DNS TXT verification record was not found');
    });

    it('rejects incidental substring matches or missing prefix', async () => {
      mockDoHResponse(200, {
        Status: 0,
        Answer: [
          // Substring match: has token without prefix
          { name: 'example.com', type: 16, TTL: 300, data: `"${token}"` },
          // Extra prefix
          { name: 'example.com', type: 16, TTL: 300, data: `"prefix-${expectedRecord}"` },
        ],
      });

      const res = await resolveTxtDnsProof('example.com', token);
      expect(res.isVerified).toBe(false);
      expect(res.status).toBe('proof_absent');
    });

    it('rejects non-TXT (type != 16) records even if data matches', async () => {
      mockDoHResponse(200, {
        Status: 0,
        Answer: [
          // Type 1 is A record, not TXT
          { name: 'example.com', type: 1, TTL: 300, data: `"${expectedRecord}"` },
        ],
      });

      const res = await resolveTxtDnsProof('example.com', token);
      expect(res.isVerified).toBe(false);
      expect(res.status).toBe('proof_absent');
    });

    it('returns unavailable when resolvers return HTTP error or network failure', async () => {
      (https.request as jest.Mock).mockImplementation(() => {
        const req: any = new EventEmitter();
        req.end = jest.fn(() => {
          req.emit('error', new Error('Network timeout'));
        });
        return req;
      });

      const res = await resolveTxtDnsProof('example.com', token);
      expect(res.isVerified).toBe(false);
      expect(res.status).toBe('unavailable');
    });

    it('rejects truncated DNS responses (TC = true)', async () => {
      mockDoHResponse(200, {
        Status: 0,
        TC: true,
        Answer: [{ name: 'example.com', type: 16, TTL: 300, data: `"${expectedRecord}"` }],
      });

      const res = await resolveTxtDnsProof('example.com', token);
      expect(res.isVerified).toBe(false);
    });
  });

  describe('resolveTxtDnsProof Success Cases', () => {
    it('verifies successfully when Cloudflare returns exact quoted TXT record', async () => {
      (https.request as jest.Mock).mockImplementation((url, _options, callback) => {
        const req: any = new EventEmitter();
        req.end = jest.fn(() => {
          const res: any = new EventEmitter();
          res.statusCode = 200;
          callback(res);
          res.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                Status: 0,
                Answer: [
                  { name: 'example.com', type: 16, TTL: 14400, data: `"${expectedRecord}"` },
                ],
              }),
            ),
          );
          res.emit('end');
        });
        return req;
      });

      const res = await resolveTxtDnsProof('example.com', token);
      expect(res.isVerified).toBe(true);
      expect(res.provider).toBe('cloudflare');
      expect(res.status).toBe('confirmed');
      expect(res.ttl).toBe(14400);
      expect(res.errorMessage).toBeNull();
    });

    it('falls back to Google DoH when Cloudflare returns empty/network error and Google finds exact record', async () => {
      let callCount = 0;
      (https.request as jest.Mock).mockImplementation((url, _options, callback) => {
        callCount++;
        const req: any = new EventEmitter();
        req.end = jest.fn(() => {
          if (callCount === 1) {
            // First call (Cloudflare): simulated 429 or empty
            const res: any = new EventEmitter();
            res.statusCode = 429;
            callback(res);
            res.emit('end');
          } else {
            // Second call (Google): succeeds with unquoted or quoted record
            const res: any = new EventEmitter();
            res.statusCode = 200;
            callback(res);
            res.emit(
              'data',
              Buffer.from(
                JSON.stringify({
                  Status: 0,
                  Answer: [
                    { name: 'example.com', type: 16, TTL: 7200, data: expectedRecord },
                  ],
                }),
              ),
            );
            res.emit('end');
          }
        });
        return req;
      });

      const res = await resolveTxtDnsProof('example.com', token);
      expect(res.isVerified).toBe(true);
      expect(res.provider).toBe('google');
      expect(res.status).toBe('confirmed');
      expect(res.ttl).toBe(7200);
    });
  });
});

