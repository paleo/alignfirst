// Stand-in for the datastore: two regions carry comparables, one is empty.
const COMPARABLES = {
  north: [
    { address: "12 Elm Street", surface: 74, price: 245000 },
    { address: "3 Oak Lane", surface: 91, price: 310000 },
  ],
  south: [{ address: "8 Pine Road", surface: 62, price: 198000 }],
  west: [],
};

export function listRegions() {
  return Object.keys(COMPARABLES);
}

export function listComparables(region) {
  return COMPARABLES[region] ?? [];
}
