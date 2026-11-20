import 'reflect-metadata';
import {validate} from 'class-validator';
import {UpdateLocaleDto,AuthController} from '../../src/modules/auth/auth.controller';
import {SignupDto} from '../../src/modules/auth/dto/signup.dto';
import {SUPPORTED_LOCALES} from '../../../shared/src/config/supported-locales';
import {readFileSync} from 'fs';
import {resolve} from 'path';
jest.mock('../../src/config/config',()=>({config:{APP:{AUTH_WEB_URL:'https://auth.example.test'},DB:{},JWT:{},SECURITY:{},EMAIL:{},DEFAULTS:{LOCALE:'en'}}}));

describe('PLAN0110 account locale contract',()=>{
  test('all 21 tags are accepted and invalid/case-ambiguous values fail',async()=>{
    for(const preferredLocale of SUPPORTED_LOCALES)expect(await validate(Object.assign(new UpdateLocaleDto(),{preferredLocale}))).toHaveLength(0);
    for(const preferredLocale of ['pt','PT-br','xx','',null,123,'en<script>'])expect((await validate(Object.assign(new UpdateLocaleDto(),{preferredLocale})))).not.toHaveLength(0);
    expect((await validate(Object.assign(new SignupDto(),{email:'user@example.test',password:'ValidPass123!',preferredLocale:'xx'}))).some(error=>error.property==='preferredLocale')).toBe(true);
  });
  test('controller derives identity exclusively from the authenticated subject',async()=>{
    const updatePreferredLocale=jest.fn().mockResolvedValue({preferredLocale:'fr'});
    const controller=new AuthController({updatePreferredLocale} as any,{} as any);
    await controller.updateLocale({sub:'authenticated-owner'} as any,{preferredLocale:'fr',userId:'attacker-target'} as any);
    expect(updatePreferredLocale).toHaveBeenCalledWith('authenticated-owner','fr');
  });
  test('frontend registry matches the API allowlist',()=>{
    const source=readFileSync(resolve(__dirname,'../../../../frontend/shared/ui/localization/locale.ts'),'utf8');
    const tags=[...source.matchAll(/\['([^']+)',/g)].map(match=>match[1]);
    expect(tags).toEqual([...SUPPORTED_LOCALES]);
  });
});
