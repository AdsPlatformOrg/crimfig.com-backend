import { ticketReference, checkSupportTransition } from '../../src/modules/support/support-policy';
describe('Support policy',()=>{
 test('rejects unknown transition and allows reopen review',()=>{expect(()=>checkSupportTransition('closed','open')).toThrow();expect(()=>checkSupportTransition('open','invalid')).toThrow();expect(()=>checkSupportTransition('closed','in_progress')).not.toThrow();});
 test('references preserve all digits with minimum seven',()=>{expect(ticketReference(1)).toBe('#0000001');expect(ticketReference('10000001')).toBe('#10000001');});
});
