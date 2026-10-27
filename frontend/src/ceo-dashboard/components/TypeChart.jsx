import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

const CHART_COLORS = ['#BFBFBF', '#F2F2F2', '#737373', '#4A4A4A', '#2E2E2E'];

export default function TypeChart({ byType }) {
  const data = (byType || []).map((item, index) => ({ tipo: item.tipo || 'N/A', cantidad: Number(item.cantidad) || 0, color: CHART_COLORS[index % CHART_COLORS.length] }));
  if (!data.length) return <div className="flex h-48 items-center justify-center text-xs text-[#737373]">Sin datos para mostrar</div>;
  return <div className="h-56 w-full"><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}><XAxis dataKey="tipo" axisLine={false} tickLine={false} tick={{ fill: '#737373', fontSize: 10 }} dy={8} /><Tooltip cursor={{ fill: '#0D0D0D' }} contentStyle={{ backgroundColor: '#141414', border: '1px solid #2E2E2E', borderRadius: 4, color: '#F2F2F2', fontSize: 12 }} labelStyle={{ color: '#F2F2F2', fontSize: 11 }} /><Bar dataKey="cantidad" radius={[2, 2, 0, 0]}>{data.map((entry, index) => <Cell key={`${entry.tipo}-${index}`} fill={entry.color} stroke="none" />)}</Bar></BarChart></ResponsiveContainer></div>;
}
