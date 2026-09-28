import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OperationsView from '../src/ceo-dashboard/views/OperationsView';
import api from '../src/ceo-dashboard/api';

vi.mock('../src/ceo-dashboard/api', () => ({ default: {
  directory: { overview: vi.fn() }, meetings: { assignResponsible: vi.fn() },
  operations: Object.fromEntries(['organization','assign','removeAssignment','escalations','escalate','incidents','resolveIncident','leads','saveLead','identities','history'].map((name) => [name,vi.fn()])),
} }));

describe('P-06 paneles operativos', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.directory.overview.mockResolvedValue({ employees:[{id:'employee',nombre:'Alan',roles:['Delineante'],activo:true}], clients:[{id:'client',nombre:'Cliente QA',activo:true}], projects:[] });
    api.operations.organization.mockResolvedValue({positions:[{id:'role',nombre:'Delineante',activo:true}],assignments:[]});
    api.operations.escalations.mockResolvedValue([]);
    api.operations.leads.mockResolvedValue([]);
    api.operations.incidents.mockResolvedValue([]);
    api.operations.identities.mockResolvedValue([]);
  });
  it('guarda un prospecto local y recarga la lista',async()=>{
    render(<OperationsView mode="leads" />);
    fireEvent.click(await screen.findByRole('button',{name:'Nuevo prospecto'}));
    fireEvent.change(screen.getByLabelText('Nombre'),{target:{value:'Prospecto nuevo'}});
    fireEvent.click(screen.getByRole('button',{name:'Guardar prospecto'}));
    await waitFor(()=>expect(api.operations.saveLead).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({name:'Prospecto nuevo',status:'new'})));
    expect(await screen.findByRole('status')).toHaveTextContent('Cambios guardados');
  });
  it('permite asignación local y distingue el ámbito del proyecto',async()=>{
    render(<OperationsView />);
    await screen.findByText('Jerarquía global y por proyecto');
    fireEvent.change(screen.getByLabelText('Cargo'),{target:{value:'role'}});
    fireEvent.change(screen.getByLabelText('Empleado'),{target:{value:'employee'}});
    fireEvent.click(screen.getByRole('button',{name:'Añadir asignación local'}));
    await waitFor(()=>expect(api.operations.assign).toHaveBeenCalledWith({cargo_id:'role',empleado_id:'employee',proyecto_id:''}));
  });
  it('escala con motivo sin usar aprobar',async()=>{
    api.operations.escalations.mockResolvedValue([{id:'meeting',name:'Reunión QA',workflow_stage:'pmc',waiting_hours:8}]);
    render(<OperationsView />);
    fireEvent.click(await screen.findByRole('button',{name:'Escalar'}));
    fireEvent.change(screen.getByLabelText('Motivo'),{target:{value:'Necesita Dirección'}});
    fireEvent.click(screen.getByRole('button',{name:'Confirmar cambio'}));
    await waitFor(()=>expect(api.operations.escalate).toHaveBeenCalledWith('meeting','Necesita Dirección'));
  });
  it('resuelve una identidad con el endpoint auditado de responsables',async()=>{
    api.operations.identities.mockResolvedValue([{id:'action',artifact_id:'meeting',title:'Consultar presupuesto'}]);
    render(<OperationsView mode="identities" />);
    fireEvent.click(await screen.findByRole('button',{name:'Vincular persona'}));
    fireEvent.change(screen.getByLabelText('Persona del directorio'),{target:{value:'employee:employee'}});
    fireEvent.click(screen.getByRole('button',{name:'Confirmar cambio'}));
    await waitFor(()=>expect(api.meetings.assignResponsible).toHaveBeenCalledWith('meeting','action',{kind:'employee',id:'employee'}));
  });
  it('no oculta fallos de carga como listas vacías',async()=>{
    api.directory.overview.mockRejectedValue(new Error('Directorio no disponible'));
    render(<OperationsView mode="clients" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Directorio no disponible');
  });
});
