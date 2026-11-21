import {BadRequestException} from '@nestjs/common';
import {APPROVED_IMAGE_AD_PRESETS,isApprovedImagePreset,canSourceFulfillPreset} from './image-ad-presets';
export type CreativeSizePolicy='legacy'|'dynamic'|'single'|'selected';
export function validateCreativeSizePolicy(policy:unknown,ids:unknown,asset:any):{sizePolicy:CreativeSizePolicy;allowedPresetIds:string|null}{
  const mode=policy??'dynamic';
  if(!['legacy','dynamic','single','selected'].includes(mode as string))throw new BadRequestException('Choose a supported creative size policy.');
  if(mode==='legacy')return {sizePolicy:'legacy',allowedPresetIds:null};
  if(ids!==undefined&&(!Array.isArray(ids)||ids.length>9||ids.some(id=>!isApprovedImagePreset(id))))throw new BadRequestException('Choose approved creative sizes.');
  const selected=[...new Set((ids??[]) as string[])];
  if(mode==='single'&&selected.length!==1||mode==='selected'&&!selected.length||mode==='dynamic'&&selected.length)throw new BadRequestException('Size selection does not match its policy.');
  const renditions=asset.preparation?.renditions??[{width:asset.width,height:asset.height,bytes:asset.bytes}];
  const available=APPROVED_IMAGE_AD_PRESETS.filter(preset=>renditions.some((source:any)=>Number.isSafeInteger(source.bytes)&&source.bytes>0&&source.bytes<=250000&&Number.isSafeInteger(source.width)&&Number.isSafeInteger(source.height)&&canSourceFulfillPreset(source.width,source.height,preset.id).eligible)).map(preset=>preset.id);
  if(!available.length||selected.some(id=>!available.includes(id)))throw new BadRequestException('The uploaded image has no compatible rendition for the chosen approved sizes. Supply an image for the required shape.');
  return {sizePolicy:mode as CreativeSizePolicy,allowedPresetIds:selected.length?JSON.stringify(selected):null};
}
export function intersectCreativeSlotSizes(slot:any,policy:unknown,storedIds:unknown):any|null{
  if(policy==null||policy==='legacy'||policy==='dynamic')return slot;
  if(!['single','selected'].includes(policy as string))return null;
  try{
    const selected=typeof storedIds==='string'?JSON.parse(storedIds):storedIds;
    if(!Array.isArray(selected)||!selected.length||selected.some(id=>!isApprovedImagePreset(id)))return null;
    const allowed=slot.allowedPresetIds==null?APPROVED_IMAGE_AD_PRESETS.map(preset=>preset.id):JSON.parse(slot.allowedPresetIds);
    if(!Array.isArray(allowed)||allowed.some(id=>!isApprovedImagePreset(id)))return null;
    const intersection=selected.filter(id=>allowed.includes(id));
    return intersection.length?{...slot,allowedPresetIds:JSON.stringify(intersection)}:null;
  }catch{return null;}
}
