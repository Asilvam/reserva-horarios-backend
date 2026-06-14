import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type WspMetaStatus = {
  enabled: boolean;
  configured: boolean;
};

@Injectable()
export class WspMetaService {
  private readonly logger = new Logger(WspMetaService.name);

  constructor(private readonly configService: ConfigService) {}

  isEnabled(): boolean {
    return this.getBoolean('WSP_META_ENABLED', false);
  }

  getStatus(): WspMetaStatus {
    return {
      enabled: this.isEnabled(),
      configured: this.hasRequiredConfig(),
    };
  }

  async sendTextMessage(to: string, text: string): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.warn('wspMETA deshabilitado. Mensaje omitido.');
      return;
    }

    const token = this.configService.get<string>('WSP_META_TOKEN');
    const phoneNumberId = this.configService.get<string>('WSP_META_PHONE_NUMBER_ID');
    const version = this.configService.get<string>('WSP_META_API_VERSION', 'v20.0');

    if (!token || !phoneNumberId) {
      this.logger.warn('wspMETA incompleto (WSP_META_TOKEN/WSP_META_PHONE_NUMBER_ID). Mensaje omitido.');
      return;
    }

    const normalizedTo = this.normalizePhone(to);
    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizedTo,
        type: 'text',
        text: {
          preview_url: false,
          body: text,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`wspMETA envio fallido (${response.status}): ${body}`);
    }
  }

  private hasRequiredConfig(): boolean {
    const token = this.configService.get<string>('WSP_META_TOKEN');
    const phoneNumberId = this.configService.get<string>('WSP_META_PHONE_NUMBER_ID');
    return Boolean(token && phoneNumberId);
  }

  private normalizePhone(to: string): string {
    return to.replace(/\D/g, '');
  }

  private getBoolean(key: string, defaultValue: boolean): boolean {
    const value = this.configService.get<string>(key);

    if (value === undefined) {
      return defaultValue;
    }

    return value.toLowerCase() === 'true';
  }
}
