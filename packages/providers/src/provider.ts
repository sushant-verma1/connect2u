// R5.1: the common interface every channel adapter implements. Zero I/O here — this is
// a type-only contract; each adapter does its own I/O.
export type Channel = "whatsapp" | "sms";

export type SendResult = Readonly<{
  providerMessageId: string;
}>;

export type SendParams = Readonly<{
  phoneNumber: string;
  code: string;
  channel: Channel;
}>;

export type ProviderError = Readonly<{
  code: "invalid_number" | "not_on_channel" | "rate_limited" | "provider_error" | "blocked";
  message: string;
}>;

export interface Provider {
  send(params: SendParams): Promise<SendResult>;
}
