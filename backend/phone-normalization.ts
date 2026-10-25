import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export class PhoneNormalizationError extends Error {
  constructor(public readonly code: 'invalid_phone' | 'country_required' | 'invalid_country' | 'country_mismatch') {
    super(code);
  }
}

export function normalizePhone(phone: unknown, country?: unknown) {
  if (typeof phone !== 'string' || phone.length > 80 || !/^[+0-9().\s-]+$/.test(phone)) {
    throw new PhoneNormalizationError('invalid_phone');
  }
  if (country !== undefined && (typeof country !== 'string' || !isSupportedCountry(country))) {
    throw new PhoneNormalizationError('invalid_country');
  }
  const compact = phone.replace(/[\s().-]/g, '');
  const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  if (!international.startsWith('+') && !country) throw new PhoneNormalizationError('country_required');
  const parsed = parsePhoneNumberFromString(international, { defaultCountry: country as CountryCode | undefined, extract: false });
  if (!parsed || !parsed.isValid() || parsed.ext) throw new PhoneNormalizationError('invalid_phone');
  if (country && parsed.country !== country) throw new PhoneNormalizationError('country_mismatch');
  return {
    phone: String(parsed.number),
    country: parsed.country || null,
    calling_code: `+${parsed.countryCallingCode}`,
  };
}
