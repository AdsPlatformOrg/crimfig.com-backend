import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PARAMTYPES_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ApiBody, ApiOperation, ApiProperty, ApiQuery, ApiResponse, ApiSecurity, ApiExtraModels } from '@nestjs/swagger';
import { getMetadataStorage } from 'class-validator';
import { IS_PUBLIC_KEY } from '../../../../shared/src/decorators';

// Response schemas are deliberately explicit. Paths/methods and request DTO fields come from
// the real controller/validation metadata, never a parallel hardcoded URL inventory.
type Schema = Record<string, any>;
const str = (): Schema => ({ type: 'string' });
const num = (): Schema => ({ type: 'number' });
const bool = (): Schema => ({ type: 'boolean' });
const enumeration = (...values: string[]): Schema => ({ type: 'string', enum: values });
const array = (items: Schema): Schema => ({ type: 'array', items });
const nullable = (schema: Schema): Schema => ({ ...schema, nullable: true });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: 'object', properties, required, additionalProperties: true,
});
const optionalObject = (properties: Record<string, Schema>): Schema => object(properties, []);
const json = (): Schema => ({ type: 'object', additionalProperties: true });
export const scheduleSchema: Schema = { oneOf: [
  object({ version: { type: 'integer', enum: [1] }, mode: enumeration('inherit') }),
  object({ version: { type: 'integer', enum: [1] }, mode: enumeration('round_the_clock', 'custom'),
    timezone: enumeration('Africa/Lagos'), ranges: array(object({ startMinute: { type: 'integer', minimum: 0, maximum: 1439 }, endMinute: { type: 'integer', minimum: 0, maximum: 1439 } })) }),
] };
const format = enumeration('banner', 'card', 'video', 'interstitial');
const status = enumeration('draft', 'active', 'paused', 'completed', 'cancelled', 'under_review', 'pending_manager_approval', 'rejected', 'suspended', 'trash');
const moderationStatus = enumeration('draft', 'pending_primary_review', 'pending_manager_approval', 'approved', 'rejected');
const jsonArrayField = (items: Schema): Schema => ({ anyOf: [str(), array(items)], nullable: true });
const imageSpecs = optionalObject({ width: num(), height: num(), bytes: num(), mimeType: str(), sha256: nullable(str()),
  preparation: nullable(json()), renditions: array(json()) });
const creative = object({ id: str(), campaignId: str(), adStackId: nullable(str()), adType: enumeration('text', 'image', 'video'),
  headline: nullable(str()), bodyText: nullable(str()), ctaText: nullable(str()), destinationUrl: str(),
  adFormat: format, mediaFormat: nullable(enumeration('image', 'gif', 'video')), imageUrl: nullable(str()), videoUrl: nullable(str()),
  posterUrl: nullable(str()), mediaAssetId: nullable(str()), reviewStatus: enumeration('pending', 'approved', 'rejected'),
  rejectionReason: nullable(str()), imageSpecs: nullable(imageSpecs), status: str() }, ['id', 'campaignId', 'destinationUrl']);
const stackSettings = optionalObject({ geoMode: enumeration('inherit', 'global', 'targeted'), locations: array(json()),
  targetDevices: array(str()), targetHours: array(num()), schedule: scheduleSchema });
const stack = object({ id: str(), campaignId: str(), name: str(), position: num(), geoMode: str(),
  targetDevices: nullable(str()), targetHours: nullable(str()), schedule: nullable(scheduleSchema),
  creatives: array(creative), settings: stackSettings, effectiveSettings: stackSettings }, ['id', 'campaignId', 'name']);
const campaignProperties = { id: str(), advertiserId: str(), title: str(), description: nullable(str()), category: nullable(str()),
  contentRevision: {type:'integer'}, currentSubmissionId:nullable(str()),approvedSubmissionId:nullable(str()),approvedRevision:nullable({type:'integer'}),submissionIntentId:nullable(str()),submittedAt:nullable(str()),
  submissionRequestId:nullable(str()),submissionState:nullable(str()),
  capabilities:object({canEdit:bool(),canBeginEdit:bool(),canSubmit:bool(),canActivate:bool(),canPause:bool(),canTrash:bool(),blocker:nullable(str())}),
  format, status, moderationStatus, pricingModel: str(), pricingVersion: num(), budgetUsdCents: num(), remainingBudgetUsdCents: num(),
  dailyBudgetUsdCents: nullable(num()), hourlyPacingUsdCents: nullable(num()), costPerClickUsdCents: num(), costPerImpressionUsdCents: num(),
  budgetUsd: num(), dailyBudgetUsd: nullable(num()), spentUsd: num(), remainingBudgetUsd: num(),
  channels: nullable(str()), targetDevices: jsonArrayField(str()), targetCountries: nullable(str()), targetStates: nullable(str()),
  targetHours: jsonArrayField(num()), schedule: nullable(scheduleSchema), frequencyCapPerDay: num(), geoMode: str(),
  geoLocations: array(json()), startsAt: nullable(str()), endsAt: nullable(str()), createdAt: str(), updatedAt: str(),
  defaultStackId: str(), adStacks: array(stack), creatives: array(creative), formats: array(format),
  impressionsCount: num(), clicksCount: num(), hoversCount: num(), touchesCount: num(), rejectionReason: nullable(str()),
};
const campaign = object(campaignProperties, ['id', 'title', 'format', 'status', 'moderationStatus', 'budgetUsdCents', 'remainingBudgetUsdCents']);
const asset = object({ assetId: str(), cdnUrl: nullable(str()), storageKey: str(), bytes: num(), mimeType: str(),
  width: nullable(num()), height: nullable(num()), sha256: nullable(str()), preparation: nullable(json()), status: str() }, ['assetId', 'cdnUrl', 'status']);
const storedAsset = object({ id: str(), ownerId: str(), storageKey: str(), cdnUrl: nullable(str()), status: str(), bytes: num(), mimeType: str() }, ['id', 'status']);
const decision = object({ id: str(), targetType: enumeration('campaign', 'creative'), targetId: str(), reviewerId: str(), decision: str() });
const reviewResult = object({ campaign, decision, stage: str(), nextStage: str(), live: bool(), isEmergencyOverride: bool() }, ['campaign', 'decision']);
export const apiErrorSchema = object({ status: enumeration('error'), statusCode: { type: 'integer' },
  code: str(), message: str(), requestId: str(), path: str(), timestamp: str(), fieldErrors: { type: 'object', additionalProperties: array(str()) } }, ['status', 'statusCode', 'code', 'message', 'requestId']);
const success = (data: Schema): Schema => object({ status: enumeration('success'), data });
const responseModels = new Map<Schema, Function>();
function responseModel(data: Schema, name: string, envelope = true): Function {
  if (responseModels.has(data)) return responseModels.get(data)!;
  class ContractResponse {}
  Object.defineProperty(ContractResponse, 'name', { value: name });
  const schema = envelope ? success(data) : data;
  for (const [property, definition] of Object.entries(schema.properties) as [string, Schema][]) {
    // Swagger's property-level `required` is a boolean; an object's schema uses an array.
    // Keep the nested schema intact instead of overwriting its required-field array.
    const propertySchema = Array.isArray(definition.required) ? { type: 'object', nullable: definition.nullable, allOf: [definition] } : definition;
    ApiProperty({ ...propertySchema, required: schema.required.includes(property) } as any)(ContractResponse.prototype, property);
  }
  responseModels.set(data, ContractResponse);
  return ContractResponse;
}

const responses: Record<string, Record<string, Schema>> = {
  CampaignsController: {
    campaignPage:object({items:array(campaign),page:{type:'integer'},pageSize:{type:'integer'},total:{type:'integer'},counts:{type:'object',additionalProperties:{type:'integer'}}}),
    saveCampaign: object(campaignProperties,['id','title','contentRevision']),
    beginEdit: object(campaignProperties,['id','title','contentRevision']),
    deleteCreative:object({deleted:bool(),creativeId:str(),contentRevision:{type:'integer'}}),
    mutationResult:object({mutation:nullable(json()),submission:nullable(object({id:str(),state:str(),contentRevision:{type:'integer'}}))}),
    getCatalog: array(object({ id: str(), title: str(), description: nullable(str()), category: nullable(str()), format, createdAt: str(), eligibleForPlacement: bool() }, ['id', 'title'])),
    getCreationCapabilities: object({ geoTargetingEnabled: bool(), imagePreparationEnabled: bool(), videoAuthoringEnabled: bool(),
      supportedAdTypes: array(enumeration('text', 'image', 'video')), scheduleVersion: num(), allowedVideoPlacements: array(str()) }, ['geoTargetingEnabled', 'supportedAdTypes']),
    getAdvertiserCampaigns: array(campaign), createCampaign: campaign, findCreationRequest: nullable(campaign),
    getCampaignDetails: object(campaignProperties, [...campaign.required, 'adStacks', 'creatives']),
    createStack: stack, updateStack: stack, deleteStack: object({ deleted: bool(), stackId: str() }, []),
    addCreative: creative, replaceCreative: creative, submitForReview: campaign,
    updateStatus: campaign,
  },
  UploadsController: { getSettings: object({ limits: object({ imageMaxBytes: num(), videoMaxBytes: num() }), allowedMimes: object({ images: array(str()), videos: array(str()) }),
      formatCompatibility: json(), storage: json(), processing: json() }),
    uploadDirect: asset, uploadPrepared: asset, readyAsset: asset,
    presign: object({ assetId: str(), storageKey: str(), cdnUrl: str(), uploadUrl: str(), expiresAt: str() }),
    complete: storedAsset, deleteAsset: storedAsset,
  },
  ModerationController: { getQueue: object({ campaigns: array(object({ id: str(), advertiserId: str(), title: str(), status, moderationStatus,
      pricingModel: str(), budgetUsdCents: num(), createdAt: str(),submissionId:str(),contentRevision:{type:'integer'} })),
      creatives: array(object({...creative.properties,submissionId:str(),contentRevision:{type:'integer'}},[...creative.required,'submissionId','contentRevision'])), totalPending: num() }),
    submissionDetail:object({campaign:object(campaignProperties,campaign.required),submissionId:str(),contentRevision:{type:'integer'},snapshot:object({campaign:object(campaignProperties,campaign.required),stacks:array(stack),creatives:array(creative),targets:array(json())})}),
    changeAudit:array(object({id:str(),actorId:str(),action:str(),requestId:str(),priorRevision:{type:'integer'},contentRevision:{type:'integer'},previousSubmissionId:nullable(str()),submissionId:nullable(str()),beforeHash:str(),afterHash:str(),changedFields:array(str()),entityIds:array(str()),createdAt:str()})),
    reviewCreative: object({ creative, decision }), primaryReviewCampaign: reviewResult, managerApprovalCampaign: reviewResult,
    reviewCampaign: reviewResult, emergencyOverride: reviewResult,
    suspendPromoter: object({ id: str(), isSuspended: bool() }),
  },
};

/** Derive documentation from actual class-validator fields (including inline controller DTOs). */
export function documentValidatedDto(dto: Function) {
  const metas = getMetadataStorage().getTargetValidationMetadatas(dto, '', false, false);
  for (const property of new Set(metas.map(m => m.propertyName))) {
    const rules = metas.filter(m => m.propertyName === property);
    const names = rules.map(m => m.name);
    const reflected = Reflect.getMetadata('design:type', dto.prototype, property);
    let schema: Schema = reflected === Number ? num() : reflected === Boolean ? bool() : reflected === Array ? array(str()) : reflected === Object ? json() : str();
    const isIn = rules.find(m => m.name === 'isIn');
    if (isIn) schema = enumeration(...isIn.constraints[0]);
    if (names.includes('isInt')) schema = { type: 'integer' };
    if (names.includes('isNumber')) schema = num();
    if (names.includes('isBoolean')) schema = bool();
    if (names.includes('isObject')) schema = property === 'schedule' ? scheduleSchema : json();
    if (names.includes('isArray')) {
      const item = rules.find(m => m.each && ['isIn', 'isString', 'isInt'].includes(m.name || ''));
      const items = item?.name === 'isIn' ? enumeration(...item.constraints[0]) : item?.name === 'isInt' ? { type: 'integer' } : str();
      schema = array(items);
    }
    if (dto.name==='SaveCampaignDto' && property==='stacks') schema=array(object({
      id:{type:'string',format:'uuid'},name:str(),geoMode:enumeration('inherit','global','targeted'),locations:array(str()),targetDevices:array(str()),schedule:scheduleSchema,
      ads:array(object({id:{type:'string',format:'uuid'},adType:enumeration('text','image','video'),headline:str(),bodyText:str(),ctaText:str(),destinationUrl:str(),adFormat:format,mediaAssetId:{type:'string',format:'uuid'}},['adType','destinationUrl']))
    },['name','ads']));
    for (const [rule, key] of [['min', 'minimum'], ['max', 'maximum'], ['minLength', 'minLength'], ['maxLength', 'maxLength'], ['arrayMaxSize', 'maxItems']] as const) {
      const meta = rules.find(m => m.name === rule);
      if (meta) { if (meta.each && schema.items) schema.items[key] = meta.constraints[0]; else schema[key] = meta.constraints[0]; }
    }
    if (names.includes('isUuid')) schema.format = 'uuid';
    // @IsOptional permits null at runtime. Preserve that, even if a TS '?' omits null.
    const optional = names.includes('isOptional');
    ApiProperty({ ...schema, required: !optional, ...(optional ? { nullable: true } : {}) } as any)(dto.prototype, property);
  }
}

/** Attach complete contract metadata to existing handlers; new undocumented handlers fail export. */
export function documentAdsController(controller: Function) {
  for (const name of Object.getOwnPropertyNames(controller.prototype)) {
    const handler = controller.prototype[name];
    const method = typeof handler === 'function' ? Reflect.getMetadata(METHOD_METADATA, handler) : undefined;
    if (method === undefined) continue;
    const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, name)!;
    const apply = (decorator: MethodDecorator) => decorator(controller.prototype, name, descriptor);
    apply(ApiOperation({ operationId: `${controller.name.replace('Controller', '')}_${name}` }));
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
    if (!isPublic) apply(ApiSecurity('bearer'));
    const roles = Reflect.getMetadata('ads:roles', handler) ?? Reflect.getMetadata('ads:roles', controller);
    Reflect.defineMetadata('ads:contract:roles', roles || [], handler);
    const types = Reflect.getMetadata(PARAMTYPES_METADATA, controller.prototype, name) || [];
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) || {};
    for (const [key, arg] of Object.entries(args) as [string, { index: number; data?: string }][]) {
      if (key.startsWith('3:') && !arg.data && types[arg.index] && types[arg.index] !== Object) documentValidatedDto(types[arg.index]);
    }
    if (name === 'updateStatus') apply(ApiBody({ schema: object({ status: enumeration('active', 'paused', 'trash') }) }));
    if (name === 'getQueue') apply(ApiQuery({ name: 'stage', required: false, enum: ['reviewer', 'manager'] }));
    if (name === 'changeAudit') apply(ApiQuery({ name: 'offset', required: false, type: Number }));
    if (name === 'uploadDirect' || name === 'uploadPrepared') {
      const prepared = name === 'uploadPrepared';
      apply(ApiBody({ schema: prepared ? object({ files: array({ type: 'string', format: 'binary' }), manifest: str() }) : object({ file: { type: 'string', format: 'binary' } }) }));
      Reflect.defineMetadata('swagger/apiConsumes', ['multipart/form-data'], handler);
    }
    if (['getMedia', 'previewMedia', 'reviewMedia'].includes(name)) {
      for (const code of [200, 206]) apply(ApiResponse({ status: code, description: 'Binary media stream', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }));
      apply(ApiResponse({ status: 416, description: 'Unsatisfiable byte range' }));
    } else {
      const data = responses[controller.name]?.[name];
      if (!data) throw new Error(`Missing API response contract for ${controller.name}.${name}`);
      const type = responseModel(data, `${controller.name.replace('Controller', '')}_${name}Response`);
      ApiExtraModels(type)(controller);
      apply(ApiResponse({ status: method === RequestMethod.POST ? 201 : 200, type }));
    }
    const errorType = responseModel(apiErrorSchema, 'AdsApiError', false);
    ApiExtraModels(errorType)(controller);
    for (const code of [400, 401, 403, 404, 409, 413, 422, 429, 500, 503]) apply(ApiResponse({ status: code, type: errorType, description: 'Sanitized API error' }));
  }
}
