const columns = {
  popular: ['tema', 'consultas', 'usuarios', 'porcentaje_resueltas', 'documento_mas_citado', 'ultima_consulta'],
  unanswered: ['tema', 'consultas', 'sin_protocolo', 'fuera_de_alcance', 'tema_sensible', 'rechazadas', 'usuario_dijo_no', 'cargos', 'ejemplos'],
};

export function protocolReportCsv(rows, section) {
  const fields = columns[section];
  if (!fields) throw new Error('Sección inválida');
  const cell = (value) => {
    const plain = Array.isArray(value) ? value.join(' | ') : value == null ? '' : String(value);
    const safe = /^[\s]*[=+@-]/u.test(plain) ? `'${plain}` : plain;
    return `"${safe.replace(/"/gu, '""')}"`;
  };
  return `\uFEFF${[fields.map(cell).join(','), ...rows.map(row => fields.map(field => cell(row[field])).join(','))].join('\r\n')}\r\n`;
}
