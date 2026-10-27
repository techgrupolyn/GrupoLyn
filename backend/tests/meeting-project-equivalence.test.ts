import { describe, expect, it } from 'vitest';
import { reviewProjectEquivalence } from '../meeting-project-equivalence.ts';

describe('Revisión de equivalencias sin aprender alias ni forzar vínculos',()=>{
  const projects=[{id:'first',name:'CALLE CATRAL 1',aliases:[],clientNames:['Jose Moya'],address:'Calle Catral 1'},{id:'second',name:'MIRADOR 9',aliases:[]}];
  it('acepta exclusivamente nombres exactos o alias ya confirmados',()=>{
    expect(reviewProjectEquivalence('calle  catral 1',projects).project?.id).toBe('first');
    expect(reviewProjectEquivalence('Catral',projects).project).toBeNull();
    expect(reviewProjectEquivalence('Catral',[{...projects[0],aliases:['Catral']}]).project?.id).toBe('first');
  });
  it('un cliente único es una propuesta de identidad, no prueba de alcance de la acción',()=>{
    expect(reviewProjectEquivalence('Vivienda Jose Moya',projects)).toMatchObject({project:null,status:'requires-identity-evidence',candidates:[expect.objectContaining({projectId:'first',reason:'client-name'})]});
  });
  it('conserva conflictos de números y fases',()=>{
    expect(reviewProjectEquivalence('Mirador 108',projects)).toMatchObject({project:null,candidates:[expect.objectContaining({qualifierConflict:true})]});
    expect(reviewProjectEquivalence('CALLE CATRAL 1 FASE 3',projects).project).toBeNull();
  });
  it('no convierte similitud del 60 por ciento ni nombres genéricos en equivalencias',()=>{
    expect(reviewProjectEquivalence('Reforma de la vivienda',projects).candidates).toEqual([]);
    expect(reviewProjectEquivalence('CALLE CATRAL',projects).project).toBeNull();
  });
  it('no acepta alias compartidos ni modifica el catálogo',()=>{
    const shared=projects.map(project=>({...project,aliases:['Casa']}));
    expect(reviewProjectEquivalence('Casa',shared).project).toBeNull();
    expect(projects[0].aliases).toEqual([]);
  });
});
