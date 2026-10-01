/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Finding a region by name with OpenStreetMap's Nominatim: English names where there are any, and the
// places and areas a user means (a town, a port, an industrial area) ahead of anything else that shares
// the name (a shop, a pharmacy).

export const nominatimHost = 'nominatim.openstreetmap.org';

export function nominatimSearchUrl(query) {
    return `https://${nominatimHost}/search?format=jsonv2&limit=10&accept-language=en&q=${encodeURIComponent(query)}`;
}

// Settlements and administrative areas first, then land a user means by a name (an industrial area, a port),
// then everything else that shares the name: a mountain, a shop, a pharmacy.
const placeRank = (place) => {
    const category = place.category ?? place.class;
    if (category === 'place' || category === 'boundary') return 3;
    if (['landuse', 'industrial', 'harbour'].includes(category) || place.type === 'port' || place.addresstype === 'industrial') return 2;
    return 0;
};

export function rankPlaces(results) {
    return results.filter((place) => Array.isArray(place.boundingbox))
        .map((place, index) => ({ place, index }))
        .sort((a, b) => (placeRank(b.place) - placeRank(a.place)) || (Number(b.place.importance ?? 0) - Number(a.place.importance ?? 0)) || (a.index - b.index))
        .map(({ place }) => place);
}
