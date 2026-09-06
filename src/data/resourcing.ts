import type { MachineType } from "../types.ts";

/** Electric Mining Rig */
export const ELECTRIC_MINING_RIG: MachineType = {
  "name": "Electric Mining Rig",
  "category": "Resourcing",
  "width": 5,
  "height": 5,
  "ports": [],
  "edgeBands": {},
  "recipes": [
    {
      "id": "recipe_1",
      "inputs": [],
      "outputs": [
        {
          "resource": "Originium Ore",
          "kind": "item",
          "rate": 30
        }
      ]
    },
    {
      "id": "recipe_2",
      "inputs": [],
      "outputs": [
        {
          "resource": "Amethyst Ore",
          "kind": "item",
          "rate": 30
        }
      ]
    }
  ]
};

/** Electric Mining Rig Mk II */
export const ELECTRIC_MINING_RIG_MK_II: MachineType = {
  "name": "Electric Mining Rig Mk II",
  "category": "Resourcing",
  "width": 5,
  "height": 5,
  "ports": [],
  "edgeBands": {},
  "recipes": [
    {
      "id": "recipe_1",
      "inputs": [],
      "outputs": [
        {
          "resource": "Ferrium Ore",
          "kind": "item",
          "rate": 30
        }
      ]
    }
  ]
};

/** Fluid Pump
 *  Pumps Clean Water at 60/min (2u); requires power. Its inlet must sit
 *  in a water body. See Docs/reference/gas-system.md for sources. */
export const FLUID_PUMP: MachineType = {
  "name": "Fluid Pump",
  "category": "Resourcing",
  "width": 5,
  "height": 5,
  "ports": [],
  "edgeBands": {
    "south": {
      "type": "output",
      "resourceKind": "fluid"
    }
  },
  "recipes": [
    {
      "id": "recipe_1",
      "inputs": [],
      "outputs": [
        {
          "resource": "Clean Water",
          "kind": "fluid",
          "rate": 1
        }
      ]
    }
  ]
};

/** Gas Extractor
 *  3x3 (Game8), needs no power (natural gas flow), must sit on a Gas
 *  Vent. Extracts ~20/min (1 gas per 3s, community-measured) — six
 *  extractors just saturate one 120/min pipe. */
export const GAS_EXTRACTOR: MachineType = {
  "name": "Gas Extractor",
  "category": "Resourcing",
  "width": 3,
  "height": 3,
  "noPower": true,
  "ports": [],
  "edgeBands": {
    "south": {
      "type": "output",
      "resourceKind": "fluid"
    }
  },
  "recipes": [
    {
      "id": "recipe_1",
      "inputs": [],
      "outputs": [
        {
          "resource": "Inergen",
          "kind": "fluid",
          "rate": 1 / 3
        }
      ]
    },
    {
      "id": "recipe_2",
      "inputs": [],
      "outputs": [
        {
          "resource": "Xiragen",
          "kind": "fluid",
          "rate": 1 / 3
        }
      ]
    }
  ]
};

/** Hydro Mining Rig */
export const HYDRO_MINING_RIG: MachineType = {
  "name": "Hydro Mining Rig",
  "category": "Resourcing",
  "width": 5,
  "height": 5,
  "ports": [],
  "edgeBands": {},
  "recipes": [
    {
      "id": "recipe_1",
      "inputs": [],
      "outputs": [
        {
          "resource": "Cuprium Ore",
          "kind": "item",
          "rate": 30
        }
      ]
    }
  ]
};

/** Portable Originium Rig */
export const PORTABLE_ORIGINIUM_RIG: MachineType = {
  "name": "Portable Originium Rig",
  "category": "Resourcing",
  "width": 5,
  "height": 5,
  "ports": [],
  "edgeBands": {},
  "recipes": [
    {
      "id": "recipe_1",
      "inputs": [],
      "outputs": [
        {
          "resource": "Originium Ore",
          "kind": "item",
          "rate": 30
        }
      ]
    }
  ]
};

