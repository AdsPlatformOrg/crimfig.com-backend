/* Offline controller metadata export. No AppModule, environment files, business services,
 * database, scheduled jobs or listening server are loaded. Also used by api:check. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
require('reflect-metadata');

const backend = path.resolve(__dirname, '..');
function loadControllers() {
  const previous = Module._extensions['.ts'];
  const original = Module._load;
  const services = new Map();
  Module._extensions['.ts'] = (mod, filename) => {
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true,
    }, fileName: filename }).outputText;
    mod._compile(code, filename);
  };
  Module._load = function (id, parent, ...rest) {
    // Only the three business providers are substituted; controller/DTO/decorator code is real.
    if (/^\.\/(campaigns|uploads|moderation)\.service$/.test(id)) {
      const name = id.match(/\/(\w+)\.service/)[1];
      const exportName = name[0].toUpperCase() + name.slice(1) + 'Service';
      if (!services.has(exportName)) services.set(exportName, { [exportName]: class {} });
      return services.get(exportName);
    }
    if (id === '@crimfig/shared') return original.call(this, path.join(backend, 'shared/src/decorators/index.ts'), parent, ...rest);
    return original.call(this, id, parent, ...rest);
  };
  try {
    const controllers = ['campaigns', 'uploads', 'moderation'].map(name => {
      const filename = path.join(backend, 'api/ads-api/src/modules', name, `${name}.controller.ts`);
      const exported = require(filename);
      return exported[name[0].toUpperCase() + name.slice(1) + 'Controller'];
    });
    const configuration = require('../api/ads-api/src/contracts/api-configuration.ts');
    return { controllers, configure: configuration.configureAdsApi, prefix: configuration.ADS_API_PREFIX, version: configuration.ADS_API_VERSION };
  } finally {
    Module._load = original;
    if (previous) Module._extensions['.ts'] = previous; else delete Module._extensions['.ts'];
  }
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
async function exportContract() {
  const { controllers, configure, prefix, version } = loadControllers();
  const { Module: NestModule } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
  class ContractModule {}
  const providers = controllers.flatMap(controller => (Reflect.getMetadata('design:paramtypes', controller) || []).map(token => ({ provide: token, useValue: Object.freeze({}) })));
  NestModule({ controllers, providers })(ContractModule);
  const app = await NestFactory.create(ContractModule, { logger: false, abortOnError: false });
  try {
    configure(app);
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('CrimFig Ads campaign API').setVersion('1').addBearerAuth(undefined, 'bearer').build());
    const { PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');
    const { RequestMethod } = require('@nestjs/common');
    const expected = [];
    for (const controller of controllers) for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      if (method === undefined) continue;
      const route = [Reflect.getMetadata(PATH_METADATA, controller), Reflect.getMetadata(PATH_METADATA, handler)].filter(v => v && v !== '/').join('/').replace(/:([\w]+)/g, '{$1}');
      const url = `/${prefix}/v${version}/${route}`;
      const verb = RequestMethod[method].toLowerCase();
      const operation = document.paths[url]?.[verb];
      if (!operation?.operationId || !Object.keys(operation.responses || {}).some(code => /^2\d\d$/.test(code))) throw new Error(`Missing contract: ${verb.toUpperCase()} ${url}`);
      operation['x-ads-roles'] = Reflect.getMetadata('ads:contract:roles', handler) || [];
      operation.security = Reflect.getMetadata('crimfig_is_public', handler) ? [] : [{ bearer: [] }];
      expected.push(`${verb.toUpperCase()} ${url}`);
    }
    const exported = Object.values(document.paths).flatMap(item => Object.keys(item).filter(k => ['get', 'post', 'put', 'patch', 'delete'].includes(k)));
    if (exported.length !== expected.length || !expected.length) throw new Error('Controller/contract operation count mismatch');
    const text = JSON.stringify(stable(document), null, 2) + '\n';
    return { document: JSON.parse(text), text, manifest: { service: 'ads', contractVersion: 1, dialect: '3.0', sha256: crypto.createHash('sha256').update(text).digest('hex'), operations: expected.sort() } };
  } finally { await app.close(); }
}
async function main() {
  const result = await exportContract();
  const destination = path.resolve(process.argv[2] || path.join(backend, 'contracts/openapi'));
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'ads-v1.json'), result.text);
  fs.writeFileSync(path.join(destination, 'ads-v1.manifest.json'), JSON.stringify(result.manifest, null, 2) + '\n');
  process.stdout.write(`Exported ${result.manifest.operations.length} offline Ads operations (${result.manifest.sha256.slice(0, 12)})\n`);
}
module.exports = { exportContract, loadControllers, stable };
if (require.main === module) main().catch(error => { process.stderr.write(`API contract export failed: ${error.message}\n`); process.exitCode = 1; });
