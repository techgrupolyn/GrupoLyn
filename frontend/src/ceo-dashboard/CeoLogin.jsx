export function hasUsableCeoToken(token) {
  try {
    const payload = String(token || '').split('.')[0];
    const session = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return Number(session?.exp) > Date.now();
  } catch {
    return false;
  }
}

const CEO_VIEWS = new Set([
  'ceo', 'dashboard', 'inbox', 'groups', 'labels', 'business', 'settings', 'templates', 'specialists', 'backoffice', 'meetings',
]);

export function isCeoView(view) {
  return CEO_VIEWS.has(String(view || '').toLowerCase());
}

export function initialDashboardView(search = '', hostname = '') {
  const requestedView = new URLSearchParams(search).get('view');
  if (requestedView && CEO_VIEWS.has(String(requestedView).toLowerCase())) return requestedView;
  return 'ceo';
}

export function shouldPollWhatsappConnection(view, connected) {
  return !connected && !isCeoView(view);
}
export function shouldShowCeoDashboard(view, ceoUser) {
  return isCeoView(view) && Boolean(ceoUser);
}

export function shouldShowCeoLogin(view, ceoUser) {
  return isCeoView(view) && !ceoUser;
}

export function isConsultationOnlyCeoUser(user) {
  return String(user?.rol || '').toLowerCase() === 'consulta_publica';
}

export function isMeetingLimitedCeoUser(user) {
  const role = String(user?.rol || '').trim().toLowerCase();
  return role.startsWith('employee:') && !['employee:direccion_de_operaciones', 'employee:director_general'].includes(role);
}

export function isMeetingEditorCeoUser(user) {
  const role = String(user?.rol || '').trim().toLowerCase();
  return ['superadmin', 'admin', 'ceo', 'employee:delineante', 'employee:pmc_proyectos', 'employee:jefe_de_proyectos', 'employee:direccion_de_operaciones', 'employee:director_general'].includes(role);
}

export function CeoLogin({ onSubmit, submitting = false, error = '' }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0d0f12] px-6">
      <form onSubmit={onSubmit} className="w-full max-w-md border border-[#2E2E2E] bg-[#141414] p-10">
        <p className="text-xs uppercase tracking-[0.3em] text-[#737373]">Superagente</p>
        <h1 className="mt-3 text-2xl font-light text-[#F2F2F2]">Dashboard</h1>
        <p className="mt-2 text-sm text-[#737373]">Ingresá con tu usuario local o con el correo y contraseña de empresa.</p>
        <input name="usuario" type="text" placeholder="Usuario o correo corporativo" required className="mt-6 h-10 w-full rounded-md border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-sm text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
        <input name="contraseña" type="password" placeholder="Contraseña" required className="mt-3 h-10 w-full rounded-md border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-sm text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
        <button type="submit" disabled={submitting} className="mt-4 w-full rounded-lg bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">
          {submitting ? 'Verificando...' : 'Ingresar'}
        </button>
        {error && <p className="mt-4 text-xs text-red-400">{error}</p>}
      </form>
    </div>
  );
}