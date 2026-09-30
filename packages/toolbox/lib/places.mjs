/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Finding a region by name with OpenStreetMap's Nominatim: English names where there are any, and the
// places and areas a user means (a town, a port, an industrial area) ahead of anything else that shares
// the name (a shop, a pharmacy).

export const nominatimHost = 'nominatim.openstreetmap.org';

export function nominatimSearchUrl(query) {
    return `https://${nominatimHost}/search?format=jsonv2&limit=10&accept-language=en&q=${encodeURIComponent(query)}`;
}

// Places and areas first (a town, a port, an industrial area), then everything else (a shop that shares the name).
export function rankPlaces(results) {
    const area = (place) => ['place', 'boundary', 'landuse', 'industrial', 'harbour', 'natural'].includes(place.category ?? place.class) || place.type === 'port' || place.addresstype === 'industrial';
    return results.filter((place) => Array.isArray(place.boundingbox))
        .map((place, index) => ({ place, index }))
        .sort((a, b) => (area(b.place) - area(a.place)) || (Number(b.place.importance ?? 0) - Number(a.place.importance ?? 0)) || (a.index - b.index))
        .map(({ place }) => place);
}

