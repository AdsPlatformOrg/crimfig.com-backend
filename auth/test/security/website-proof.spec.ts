import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as dns from 'dns/promises';
import * as https from 'https';
import { deadline, fetchWebsiteProof, hasVerificationMeta, publicIpv4, websiteTarget } from '../../../api/ads-api/src/modules/verification/website-proof';

jest.mock('dns/promises', () => ({ lookup: jest.fn(), resolveTxt: jest.fn() }));
jest.mock('https', () => ({ request: jest.fn() }));
const lookup = dns.lookup as jest.Mock;
const requestMock = https.request as jest.Mock;
const target = new URL('https://example.com/');
const token = 'cf_verify_1234567890123456';

beforeEach(() => { jest.clearAllMocks(); lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]); });

test.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.100.100.200', '172.16.0.1', '192.168.1.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', '2001:4860:4860::8888'])(
  'fails closed for unsupported/reserved address %s', address => expect(publicIpv4(address)).toBe(false));
test('allows public IPv4', () => expect(publicIpv4('93.184.216.34')).toBe(true));
test.each(['http://example.com', 'https://other.com', 'https://example.com:8443', 'https://user@example.com', 'https://example.com/path', 'https://example.com/?url=x', 'https://example.com/#x'])(
  'rejects unsafe or mismatched URL %s', url => expect(() => websiteTarget('example.com', url)).toThrow());
test('canonical domain root accepted', () => expect(websiteTarget('EXAMPLE.COM', target.href).href).toBe(target.href));
test('exact meta attributes in either order accepted', () => {
  expect(hasVerificationMeta(`<meta content='${token}' NAME="crimfig-site-verification">`, token)).toBe(true);
});
test.each([
  token, `<div>${token}</div>`, `<meta name="other" content="${token}">`,
  `<!-- <meta name="crimfig-site-verification" content="${token}"> -->`,
  `<script><meta name="crimfig-site-verification" content="${token}"></script>`,
  `<meta name="crimfig-site-verification" content="prefix${token}">`,
  `<meta name="crimfig-site-verification" name="other" content="${token}">`,
])('rejects incidental/malformed proof %s', html => expect(hasVerificationMeta(html, token)).toBe(false));
test('rejects mixed public/private DNS before connecting', async () => {
  lookup.mockResolvedValue([{ address: '93.184.216.34' }, { address: '127.0.0.1' }]);
  await expect(fetchWebsiteProof(target)).rejects.toThrow();
  expect(requestMock).not.toHaveBeenCalled();
});
function fixture(status = 200, body = '<html>ok</html>', headers = { 'content-type': 'text/html' }) {
  let options: any;
  const request: any = new EventEmitter();
  request.destroy = jest.fn((error?: Error) => { if (error) request.emit('error', error); request.emit('close'); });
  request.end = () => queueMicrotask(() => {
    const response: any = new PassThrough();
    response.statusCode = status; response.headers = headers;
    const callback = requestMock.mock.calls[0][2];
    callback(response);
    response.end(body);
    response.on('end', () => request.emit('close'));
  });
  requestMock.mockImplementation((_url, supplied) => { options = supplied; return request; });
  return { request, options: () => options };
}
test('pins lookup while retaining HTTPS hostname and disables shared agent', async () => {
  const setup = fixture();
  await expect(fetchWebsiteProof(target)).resolves.toBe('<html>ok</html>');
  const callback = jest.fn(); setup.options().lookup('example.com', {}, callback);
  expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  expect(requestMock.mock.calls[0][0].hostname).toBe('example.com');
  expect(setup.options().agent).toBe(false);
});
test('redirect rejected without a second request', async () => {
  fixture(302);
  await expect(fetchWebsiteProof(target)).rejects.toThrow('redirects');
  expect(requestMock).toHaveBeenCalledTimes(1);
});
test('streamed oversized body rejected without relying on content length', async () => {
  fixture(200, 'x'.repeat(512 * 1024 + 1));
  await expect(fetchWebsiteProof(target)).rejects.toThrow('size limit');
});
test('non HTML rejected', async () => {
  fixture(200, '{}', { 'content-type': 'application/json' });
  await expect(fetchWebsiteProof(target)).rejects.toThrow('HTML');
});
test('deadline bounds stalled resolver', async () => {
  await expect(deadline(new Promise(() => {}), 5)).rejects.toThrow('timed out');
});

import { VerificationService } from '../../../api/ads-api/src/modules/verification/verification.service';
function database(row: any) {
  const saved: any = {};
  const query: any = { from: () => query, where: () => query, limit: async () => row ? [row] : [] };
  const update: any = { set: (value: any) => { Object.assign(saved, value); return update; }, where: () => update, returning: async () => [saved] };
  return { select: () => query, update: jest.fn(() => update), saved };
}
const site = { id: 'site', promoterId: 'owner', domain: 'example.com', url: target.href, verificationToken: token, verificationMethod: 'dns_txt', verifiedAt: new Date() };
test('TXT chunks joined within one record and exact proof accepted', async () => {
  (dns.resolveTxt as jest.Mock).mockResolvedValue([['crimfig-site-', `verification=${token}`]]);
  const db = database(site);
  expect((await new VerificationService(db as any).verifyWebsite('owner', 'site')).isVerified).toBe(true);
});
test('incidental TXT substring rejected and stale verified timestamp cleared', async () => {
  (dns.resolveTxt as jest.Mock).mockResolvedValue([[`prefix crimfig-site-verification=${token}`], [token]]);
  const db = database(site);
  expect((await new VerificationService(db as any).verifyWebsite('owner', 'site')).isVerified).toBe(false);
  expect(db.saved.verifiedAt).toBeNull();
});
test('missing owned website rejected before DNS/network or update', async () => {
  const db = database(null);
  await expect(new VerificationService(db as any).verifyWebsite('other', 'site')).rejects.toThrow('Website not found');
  expect(dns.resolveTxt).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled();
});
test('unsafe legacy URL fails without outgoing request', async () => {
  const db = database({ ...site, url: 'http://127.0.0.1' });
  expect((await new VerificationService(db as any).verifyWebsite('owner', 'site')).isVerified).toBe(false);
  expect(dns.resolveTxt).not.toHaveBeenCalled(); expect(requestMock).not.toHaveBeenCalled();
});
test('quoted attribute text is not a meta element', () => {
  expect(hasVerificationMeta(`<div title='<meta name="crimfig-site-verification" content="${token}">'>x</div>`, token)).toBe(false);
});
