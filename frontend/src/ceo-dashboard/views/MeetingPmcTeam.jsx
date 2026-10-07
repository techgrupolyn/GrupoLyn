export default function MeetingPmcTeam({ meeting }) {
  const people = (meeting.pmc_assignments || []).filter((person) => person.employee_id && person.name);
  const additional = people.filter((person) => person.employee_id !== meeting.pmc_employee_id);
  return <div className="text-[11px] text-[#BFBFBF]">
    {meeting.pmc && <p>{meeting.pmc_in_training ? 'PMC en prácticas' : 'PMC a cargo'}: {meeting.pmc}{meeting.pmc_employee_id && <span className="ml-1 text-emerald-200" aria-label="Vinculado">✓</span>}</p>}
    {additional.length > 0 && <details onClick={(event) => event.stopPropagation()} className="mt-1">
      <summary className="cursor-pointer text-amber-100">Equipo del proyecto · {additional.length}</summary>
      <ul className="mt-1 space-y-1">{additional.map((person) => <li key={person.employee_id}>{person.name} · {person.in_training ? 'PMC en prácticas' : 'PMC'}</li>)}</ul>
    </details>}
    {!meeting.pmc && !people.length && <p className="text-amber-200">PMC pendiente de vincular</p>}
  </div>;
}
