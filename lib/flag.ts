// IOC 3-letter country code → flag emoji.
// Most IOC codes match ISO-3166-1 alpha-3; a handful diverge (GER vs DEU, etc).
// We map IOC → ISO alpha-2 for tennis-relevant nations, then build the flag emoji
// from regional indicator symbols.

const IOC_TO_ISO2: Record<string, string> = {
  ARG: 'AR', AUS: 'AU', AUT: 'AT', BEL: 'BE', BIH: 'BA', BLR: 'BY', BRA: 'BR',
  BUL: 'BG', CAN: 'CA', CHI: 'CL', CHN: 'CN', COL: 'CO', CRO: 'HR', CYP: 'CY',
  CZE: 'CZ', DEN: 'DK', ECU: 'EC', EGY: 'EG', ESP: 'ES', EST: 'EE', FIN: 'FI',
  FRA: 'FR', GBR: 'GB', GEO: 'GE', GER: 'DE', GRE: 'GR', HKG: 'HK', HUN: 'HU',
  INA: 'ID', IND: 'IN', IRL: 'IE', IRI: 'IR', ISL: 'IS', ISR: 'IL', ITA: 'IT',
  JAM: 'JM', JPN: 'JP', KAZ: 'KZ', KOR: 'KR', KSA: 'SA', LAT: 'LV', LBN: 'LB',
  LTU: 'LT', LUX: 'LU', MAR: 'MA', MEX: 'MX', MON: 'MC', NED: 'NL', NOR: 'NO',
  NZL: 'NZ', PAR: 'PY', PER: 'PE', PHI: 'PH', POL: 'PL', POR: 'PT', PUR: 'PR',
  ROU: 'RO', RSA: 'ZA', RUS: 'RU', SLO: 'SI', SRB: 'RS', SUI: 'CH', SVK: 'SK',
  SWE: 'SE', THA: 'TH', TPE: 'TW', TUN: 'TN', TUR: 'TR', UKR: 'UA', URU: 'UY',
  USA: 'US', UZB: 'UZ', VEN: 'VE', VIE: 'VN',
}

export function countryFlag(ioc: string | null | undefined): string {
  if (!ioc) return ''
  const iso2 = IOC_TO_ISO2[ioc.toUpperCase()]
  if (!iso2) return ''
  return String.fromCodePoint(
    ...iso2.split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 'A'.charCodeAt(0))
  )
}
