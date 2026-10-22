import type { DynamicVehicleParameters, VehicleBody } from './types';
import { validateDynamicParameters } from './parameters';

/** Derived chassis data only; BSD notice shipped in public/licenses and dist/licenses. */
export const VEHICLE_REFERENCES: { id: string; name: string; vehicleTypes: DynamicVehicleParameters['vehicleTypes']; body: VehicleBody }[] = [
  {
    "id": "commonroad-vehicle1",
    "name": "Ford Escort",
    "vehicleTypes": [
      "car"
    ],
    "body": {
      "mass": 1225.8878467253344,
      "yawInertia": 1538.8533713561394,
      "length": 4.298,
      "width": 1.674,
      "lf": 0.88392,
      "lr": 1.50876,
      "trackFront": 1.389888,
      "trackRear": 1.423416,
      "cgHeight": 0.5577840000000001,
      "bodyCenterOffset": 0,
      "source": {
        "kind": "reference",
        "description": "Ford Escort prototype, CommonRoad 2020a. YAML sprung-mass CG/Iz used in planar reduction; primary DOT table not independently verified.",
        "url": "https://gitlab.lrz.de/tum-cps/commonroad-vehicle-models/-/raw/8de058935fdf5b404eef0836785b4cc1830e6d09/PYTHON/vehiclemodels/parameters/parameters_vehicle1.yaml",
        "retrievedAt": "2026-10-22"
      },
      "bodyCenterSource": {
        "kind": "synthetic",
        "description": "OBB centred at CG because front/rear overhang measurements are unavailable. Explicit geometry assumption."
      }
    }
  },
  {
    "id": "commonroad-vehicle2",
    "name": "BMW 320i",
    "vehicleTypes": [
      "car"
    ],
    "body": {
      "mass": 1093.2952334674046,
      "yawInertia": 1791.5995300122856,
      "length": 4.508,
      "width": 1.61,
      "lf": 1.1561957064,
      "lr": 1.4227170936,
      "trackFront": 1.38684,
      "trackRear": 1.36398,
      "cgHeight": 0.5748689544000001,
      "bodyCenterOffset": 0,
      "source": {
        "kind": "reference",
        "description": "BMW 320i prototype, CommonRoad 2020a. YAML sprung-mass CG/Iz used in planar reduction; primary DOT table not independently verified.",
        "url": "https://gitlab.lrz.de/tum-cps/commonroad-vehicle-models/-/raw/8de058935fdf5b404eef0836785b4cc1830e6d09/PYTHON/vehiclemodels/parameters/parameters_vehicle2.yaml",
        "retrievedAt": "2026-10-22"
      },
      "bodyCenterSource": {
        "kind": "synthetic",
        "description": "OBB centred at CG because front/rear overhang measurements are unavailable. Explicit geometry assumption."
      }
    }
  },
  {
    "id": "commonroad-vehicle3",
    "name": "VW Vanagon",
    "vehicleTypes": [
      "van"
    ],
    "body": {
      "mass": 1478.8979637767998,
      "yawInertia": 2473.1176915564442,
      "length": 4.569,
      "width": 1.844,
      "lf": 1.1507916024,
      "lr": 1.3211363976000001,
      "trackFront": 1.574292,
      "trackRear": 1.5438120000000002,
      "cgHeight": 0.7478167416,
      "bodyCenterOffset": 0,
      "source": {
        "kind": "reference",
        "description": "VW Vanagon prototype, CommonRoad 2020a. YAML sprung-mass CG/Iz used in planar reduction; primary DOT table not independently verified.",
        "url": "https://gitlab.lrz.de/tum-cps/commonroad-vehicle-models/-/raw/8de058935fdf5b404eef0836785b4cc1830e6d09/PYTHON/vehiclemodels/parameters/parameters_vehicle3.yaml",
        "retrievedAt": "2026-10-22"
      },
      "bodyCenterSource": {
        "kind": "synthetic",
        "description": "OBB centred at CG because front/rear overhang measurements are unavailable. Explicit geometry assumption."
      }
    }
  }
];

export type DynamicEquipment = Pick<DynamicVehicleParameters, 'tyres' | 'brakes' | 'drive' | 'loadTransfer'>;

/** A reference chassis is deliberately NOT a complete, measured vehicle model. */
export function parametersFromReference(id: string, equipment: DynamicEquipment): DynamicVehicleParameters {
  const reference = VEHICLE_REFERENCES.find(p => p.id === id);
  if (!reference) throw new Error('Динамика: неизвестный прототип');
  const parameters: DynamicVehicleParameters = structuredClone({
    schemaVersion: 1, id, vehicleTypes: reference.vehicleTypes, body: reference.body,
    tyres: equipment.tyres, brakes: equipment.brakes, drive: equipment.drive, loadTransfer: equipment.loadTransfer,
  });
  validateDynamicParameters(parameters);
  return parameters;
}

/** Analytical fixture, not typical/measured properties of a real car. Fresh copy per call. */
export function syntheticVehicle(): DynamicVehicleParameters {
  const source = { kind: 'synthetic' as const, description: 'Analytical verification fixture; no measured vehicle or tyre attribution.' };
  return {
    schemaVersion: 1, id: 'synthetic-verification-car', vehicleTypes: ['car'],
    body: { mass: 1500, yawInertia: 2500, length: 4.5, width: 1.8, lf: 1.4, lr: 1.4,
      trackFront: 1.5, trackRear: 1.5, cgHeight: 0.5, bodyCenterOffset: 0, source: { ...source }, bodyCenterSource: { ...source } },
    tyres: { model: 'dugoff', longitudinalStiffness: 100000, corneringStiffnessFront: 40000,
      corneringStiffnessRear: 40000, frictionScaleX: 1, frictionScaleY: 1, source: { ...source } },
    brakes: { maxForce: 50000, frontFraction: 0.6, abs: 'unknown', source: { ...source } },
    drive: { maxForce: 8000, axle: 'rear', source: { ...source } },
    loadTransfer: { frontRollFraction: 0.5, source: { ...source } },
  };
}
