import { useEffect, useState } from 'react';
import api from '../api';

export default function BackofficeView() {
  const [roles, setRoles] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ numero: '', nombre: '', apellido: '', empresa: '', rol_id: '' });
  const [error, setError] = useState('');
  const [newRol, setNewRol] = useState({ id: '', nombre: '', descripcion: '' });
  const [savingRol, setSavingRol] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.roles().then((data) => { if (!cancelled) setRoles(Array.isArray(data) ? data : []); });
    api.employees().then((data) => { if (!cancelled) setEmployees(Array.isArray(data) ? data : []); });
    return () => { cancelled = true; };
  }, []);

  const crearRol = async (e) => {
    e.preventDefault();
    if (!newRol.id || !newRol.nombre) return;
    setSavingRol(true);
    try {
      await api.createRole(newRol);
      setNewRol({ id: '', nombre: '', descripcion: '' });
      const data = await api.roles();
      setRoles(Array.isArray(data) ? data : []);
    } catch { /* ignore */ } finally { setSavingRol(false); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.numero.trim() || !form.nombre.trim() || !form.rol_id) {
      setError('Número, nombre y rol son obligatorios');
      return;
    }
    setLoading(true);
    try {
      await api.createEmployee({ numero: form.numero.trim(), nombre: form.nombre.trim(), apellido: form.apellido.trim(), empresa: form.empresa.trim(), rol_id: form.rol_id });
      setForm({ numero: '', nombre: '', apellido: '', empresa: '', rol_id: form.rol_id });
      const data = await api.employees();
      setEmployees(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(String(err?.message || 'Error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-10">
      <h2 className="font-display text-2xl font-medium text-[#F2F2F2] tracking-wide">Backoffice</h2>
      <p className="mt-2 text-xs text-[#737373]">Roles, empleados, permisos y accesos.</p>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <form onSubmit={crearRol} className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Alta/edición de rol</p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input value={newRol.id} onChange={(e) => setNewRol((f) => ({ ...f, id: e.target.value }))} placeholder="ID" className="h-9 rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
            <input value={newRol.nombre} onChange={(e) => setNewRol((f) => ({ ...f, nombre: e.target.value }))} placeholder="Nombre" className="h-9 rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
            <input value={newRol.descripcion} onChange={(e) => setNewRol((f) => ({ ...f, descripcion: e.target.value }))} placeholder="Descripción" className="h-9 rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
            <button type="submit" disabled={savingRol} className="sm:col-span-3 rounded-md bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">
              {savingRol ? 'Guardando...' : 'Guardar rol'}
            </button>
          </div>
        </form>

        <div className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Roles existentes</p>
          <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto">
            {roles.map((r) => (
              <li key={r.id} className="flex items-center justify-between rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-4 py-2 text-xs text-[#F2F2F2]">
                <span>{r.nombre}</span>
                <span className="text-[#737373]">{r.id}</span>
              </li>
            ))}
            {!roles.length && <p className="text-xs text-[#737373]">Sin roles</p>}
          </ul>
        </div>

        <form onSubmit={handleSubmit} className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Alta/edición de empleado</p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input value={form.numero} onChange={(e) => setForm((f) => ({ ...f, numero: e.target.value.replace(/\D/g, '') }))} placeholder="Número" className="h-9 rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
            <input value={form.nombre} onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))} placeholder="Nombre" className="h-9 rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
            <input value={form.apellido} onChange={(e) => setForm((f) => ({ ...f, apellido: e.target.value }))} placeholder="Apellido" className="h-9 rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
            <input value={form.empresa} onChange={(e) => setForm((f) => ({ ...f, empresa: e.target.value }))} placeholder="Empresa" className="h-9 rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
            <select value={form.rol_id} onChange={(e) => setForm((f) => ({ ...f, rol_id: e.target.value }))} className="h-9 rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none">
              <option value="">Seleccionar rol</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>{r.nombre}</option>
              ))}
            </select>
            <button type="submit" disabled={loading} className="sm:col-span-2 rounded-md bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">
              {loading ? 'Guardando...' : 'Guardar empleado'}
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </form>

        <div className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Empleados existentes</p>
          <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto">
            {employees.map((e) => (
              <li key={e.id} className="flex items-center justify-between rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-4 py-2 text-xs text-[#F2F2F2]">
                <span>{e.nombre} {e.apellido}</span>
                <span className="text-[#737373]">{e.numero} · {e.rol_nombre || 'Sin rol'}</span>
              </li>
            ))}
            {!employees.length && <p className="text-xs text-[#737373]">Sin empleados</p>}
          </ul>
        </div>
      </div>
    </div>
  );
}
