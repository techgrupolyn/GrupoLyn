const ROLE_THEMES = [
  { key: 'interiorista', label: 'Interiorista', match: /interiorista|interiorismo/i, accent: '#B478E6', background: 'rgba(180, 120, 230, 0.14)', border: 'rgba(180, 120, 230, 0.58)', text: '#E4C8FA' },
  { key: 'planimetrista', label: 'Planimetrista', match: /planimetrista|planos?/i, accent: '#32C8DD', background: 'rgba(50, 200, 221, 0.13)', border: 'rgba(50, 200, 221, 0.56)', text: '#B8F4FA' },
  { key: 'director', label: 'Director', match: /director|direcci[oó]n/i, accent: '#F2A45D', background: 'rgba(242, 164, 93, 0.14)', border: 'rgba(242, 164, 93, 0.58)', text: '#FFD4AD' },
  { key: 'visor-planos', label: 'Visor de planos', match: /visor.*planos?|visualizador/i, accent: '#46CB92', background: 'rgba(70, 203, 146, 0.13)', border: 'rgba(70, 203, 146, 0.56)', text: '#B8F4D4' },
  { key: 'subcontrata', label: 'Subcontrata', match: /proveedor|subcontrata/i, accent: '#E9C66E', background: 'rgba(233, 198, 110, 0.13)', border: 'rgba(233, 198, 110, 0.55)', text: '#FCEBC0' },
  { key: 'superadmin', label: 'Superadmin', match: /superadmin|administrador/i, accent: '#E78396', background: 'rgba(231, 131, 150, 0.13)', border: 'rgba(231, 131, 150, 0.56)', text: '#FFD0D9' },
];

const DEFAULT_THEME = { key: 'default', label: 'Sin rol', accent: '#8FC7E8', background: 'rgba(143, 199, 232, 0.11)', border: 'rgba(143, 199, 232, 0.46)', text: '#DDF3FF' };

export function roleTheme(role) {
  const value = String(role || '').trim();
  return ROLE_THEMES.find((theme) => theme.match.test(value)) || DEFAULT_THEME;
}

export function primaryRole(roles) {
  const list = Array.isArray(roles) ? roles : [roles];
  return list.find((role) => String(role || '').trim()) || null;
}

export const highlightedRoleThemes = ROLE_THEMES.filter((theme) => ['interiorista', 'planimetrista', 'director', 'visor-planos'].includes(theme.key));
export function roleLabel(role) {
  const value = String(role || '').trim();
  const theme = roleTheme(value);
  return theme.key === 'subcontrata' ? theme.label : value || theme.label;
}