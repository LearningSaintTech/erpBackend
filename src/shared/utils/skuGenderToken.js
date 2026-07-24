const GENDER_TOKEN_MAP = {
  MEN: 'M', MALE: 'M', M: 'M', BOYS: 'M',
  WOMEN: 'F', WOMAN: 'F', FEMALE: 'F', F: 'F', GIRLS: 'F',
  UNISEX: 'UNI', UNI: 'UNI',
  KIDS: 'K', K: 'K',
};

export function genderToToken(gender) {
  if (!gender) return '';
  return GENDER_TOKEN_MAP[String(gender).trim().toUpperCase()] || '';
}

export function buildStyleGenderSegment(styleNumber, gender) {
  const style = String(styleNumber || '').trim().toUpperCase().replace(/\s+/g, '');
  const token = genderToToken(gender);
  if (!style) return '';
  return token ? `${style}${token}` : style;
}
