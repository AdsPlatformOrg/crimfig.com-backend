import { UrgentEmailTransport } from './alerts';

/** Dedicated sender credentials; no ordinary error-monitor suppression or opt-out. */
export class BrevoUrgentEmailTransport implements UrgentEmailTransport {
  constructor(private readonly apiKey: string, private readonly sender: string, private readonly request: typeof fetch = fetch) {
    if (!apiKey || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) throw new Error('Urgent sender configuration unavailable');
  }
  async submit(input: {messageId:string;recipient:string;subject:string;text:string}) {
    const response = await this.request('https://api.brevo.com/v3/smtp/email',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{'api-key':this.apiKey,'Content-Type':'application/json'},
      body:JSON.stringify({sender:{email:this.sender},to:[{email:input.recipient}],subject:input.subject,textContent:input.text,
        headers:{'X-CrimFig-Alert-ID':input.messageId},tags:['financial-security']}),
    });
    const result:any = await response.json();
    if (!response.ok || typeof result?.messageId !== 'string' || !result.messageId) throw new Error('Urgent email submission unconfirmed');
    return {providerId:result.messageId};
  }
}
