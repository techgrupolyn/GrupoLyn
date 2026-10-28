import { createProtocolCorpus } from '../protocol-corpus.ts';

export const syntheticCorpus = createProtocolCorpus([
  { id: 'DISENO', name: 'Control de la fase de Diseño (extracto real)', mimeType: 'text/plain', modifiedTime: '2026-10-26', revision: '1', warnings: [], sections: [{ ref: 'diapositiva 4', text: 'Viernes 30 min — revisión semanal:\nprimero PMC–interiorista y después PMC–planimetrista.' }] },
  { id: 'PRESUPUESTOS', name: 'Control de presupuestos (extracto real)', mimeType: 'text/plain', modifiedTime: '2026-10-26', revision: '1', warnings: [], sections: [{ ref: 'diapositiva 2', text: 'El PMC revisa el presupuesto, lo sube a Club LYN y controla su avance hasta la aprobación del cliente.' }] },
  { id: 'MATERIALES', name: 'Control de materiales (extracto real)', mimeType: 'text/plain', modifiedTime: '2026-10-26', revision: '1', warnings: [], sections: [{ ref: 'diapositiva 2', text: 'Cada pedido tiene un responsable, tanto si compra LYN como si compra la subcontrata. Su seguimiento abarca aprobación, pedido, fabricación, transporte y recepción.' }] },
  { id: 'OBRA', name: 'Control de obra (extracto real)', mimeType: 'text/plain', modifiedTime: '2026-10-26', revision: '1', warnings: [], sections: [{ ref: 'diapositiva 5', text: 'puede mover los niveles 2 y 3 si mantiene las fechas del nivel 1, las dependencias, los materiales y los compromisos con otros responsables.' }] },
  { id: 'MANUAL', name: 'Manual de responsables (extracto real)', mimeType: 'text/plain', modifiedTime: '2026-10-26', revision: '1', warnings: [], sections: [{ ref: 'página 2', text: 'Solo Alex puede moverlos PMC solo notifica desviación.' }] },
], 10000);

const source = (doc_id: string, seccion: string, cita: string) => ({ doc_id, seccion, cita });
const designSource = source('DISENO', 'diapositiva 4', 'Viernes 30 min — revisión semanal: primero PMC–interiorista y después PMC–planimetrista.');
const budgetSource = source('PRESUPUESTOS', 'diapositiva 2', 'El PMC revisa el presupuesto, lo sube a Club LYN y controla su avance hasta la aprobación del cliente.');
const materialsSource = source('MATERIALES', 'diapositiva 2', 'Cada pedido tiene un responsable, tanto si compra LYN como si compra la subcontrata. Su seguimiento abarca aprobación, pedido, fabricación, transporte y recepción.');
const obraSource = source('OBRA', 'diapositiva 5', 'puede mover los niveles 2 y 3 si mantiene las fechas del nivel 1');
const manualSource = source('MANUAL', 'página 2', 'Alex puede moverlos PMC solo notifica desviación.');

export const protocolQaCases = [
  ...[
    '¿Cuándo se revisa semanalmente el diseño?',
    '¿La revisión semanal de diseño con el PMC es el viernes?',
    '¿Cuánto dura la revisión semanal de diseño con el PMC?',
    '¿Quién se reúne primero con el PMC en la revisión semanal de diseño?',
    '¿El planimetrista va antes o después de la interiorista en la revisión semanal de diseño?',
  ].map(question => ({ question, category: 'con_respuesta', expected: 'resuelta', answer: { clasificacion: 'resuelta', respuesta: 'La revisión semanal es el viernes, dura 30 minutos y se hace primero con interiorismo y después con planimetría.', fuentes: [designSource], motivo_no_respuesta: null, cargo_derivacion: null, contradiccion: null, area: 'diseno', tema: 'revision semanal de diseno' } })),
  ...[
    '¿Quién revisa el presupuesto?',
    '¿Se revisa el presupuesto antes de subirlo a Club LYN?',
    '¿Subimos el presupuesto sin revisión previa?',
    '¿Qué cargo comprueba el presupuesto?',
    '¿En qué orden se revisa y sube el presupuesto?',
  ].map(question => ({ question, category: 'con_respuesta', expected: 'resuelta', answer: { clasificacion: 'resuelta', respuesta: 'El PMC revisa el presupuesto, lo sube a Club LYN y controla su avance hasta la aprobación del cliente.', fuentes: [budgetSource], motivo_no_respuesta: null, cargo_derivacion: null, contradiccion: null, area: 'presupuestos', tema: 'revision del presupuesto' } })),
  ...[
    '¿Cada pedido de materiales debe tener un responsable?',
    '¿También tiene responsable si compra la subcontrata?',
    '¿Qué etapas abarca el seguimiento de un pedido?',
    '¿El seguimiento de materiales incluye la fabricación?',
    '¿Hasta qué etapa se sigue un pedido de materiales?',
  ].map(question => ({ question, category: 'con_respuesta', expected: 'resuelta', answer: { clasificacion: 'resuelta', respuesta: 'Cada pedido tiene un responsable; se siguen aprobación, pedido, fabricación, transporte y recepción.', fuentes: [materialsSource], motivo_no_respuesta: null, cargo_derivacion: null, contradiccion: null, area: 'materiales', tema: 'seguimiento de pedidos' } })),
  ...[
    '¿Cuántos días tiene el cliente para reclamar después de la entrega?',
    '¿En cuántas horas debemos archivar la minuta de una reunión en Club LYN?',
    '¿Qué nomenclatura debe llevar la minuta de reunión antes de archivarla?',
    '¿Cuándo se elimina una alerta ya cerrada en Club LYN?',
    '¿Cuál es el plazo de garantía del electrodoméstico?',
  ].map(question => ({ question, category: 'sin_protocolo', expected: 'no_urgente', answer: { clasificacion: 'no_urgente', respuesta: 'No está en los protocolos disponibles. Consulta con el PMC y registra la duda para seguimiento.', fuentes: [], motivo_no_respuesta: 'sin_protocolo', cargo_derivacion: 'PMC', contradiccion: null, area: 'otro', tema: 'consulta sin protocolo' } })),
  ...[
    'Hay olor a gas en la obra, ¿qué hago?',
    'Una persona herida necesita ayuda ahora.',
    'Hay fuego en la obra y peligro para alguien.',
  ].map(question => ({ question, category: 'urgente', expected: 'urgente', answer: null })),
  ...[
    '¿Puede el PMC mover una tarea de nivel 2 de obra?',
    '¿Quién puede cambiar los plazos de una tarea de nivel 3?',
  ].map(question => ({ question, category: 'contradiccion', expected: 'no_urgente', answer: { clasificacion: 'no_urgente', respuesta: 'Los dos documentos no coinciden. No cambies el plazo sin confirmarlo con Operaciones.', fuentes: [obraSource, manualSource], motivo_no_respuesta: null, cargo_derivacion: 'Operaciones', contradiccion: { doc_a: 'OBRA', doc_b: 'MANUAL', descripcion: 'Quién puede mover plazos de tareas de obra' }, area: 'responsables_y_escalado', tema: 'cambio de plazos' } })),
] as const;
