<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Walkthrough: a grocery network in Bangalore

A script for a short recording (about eight minutes) of the toolbox on a real city. It follows one question a practitioner would ask: *my dairy is short for ten days; what does it cost me, and what would have helped?*

The network is in [walkthrough/bangalore.csv](walkthrough/bangalore.csv): three suppliers, two distribution centres, twelve stores and a dark store, in three categories. **Its sites are invented.** The places are real and the positions approximate; no company's network is shown, and every quantity in the file is made up. Say so in the recording. The roads and the travel times over them are OpenStreetMap's.

Scenes 1 to 6 were run end to end in the real app on 8 October 2026, and the figures quoted are from that run. Scenes 7 and 8 were not tried by the author on this network (the window and engine tests cover what they use), so rehearse them once and read the figures off the screen. Use the Konjugate release after 1.1.10, or Konjugate from its source: see scene 7.

## Before recording

1. Open Konjugate with the toolbox installed and press **Logistics**.
2. Search *Bangalore*, keep **25 km around it** and **Major roads (a region)**, and press **Load roads**. This took three and a half minutes in the trial and is kept on the computer afterwards, so do it before recording: in the recording the same button answers at once.
3. Close the window and open it again, so the recording starts from an empty map.

## The recording

| # | About | Do | Say | Expect |
|---|---|---|---|---|
| 1 | 0:30 | Search *Bangalore*, **Load roads**. | The map is OpenStreetMap's: its roads, and nothing else until I ask. | The major roads of an area 85 × 84 km. |
| 2 | 1:00 | **Load your sites (CSV)**, choose `bangalore.csv`. Click a store, then a supplier, to show their cards. | These sites are invented for the demonstration. A site can be placed by hand from the palette too, and dragged. Each figure says where it came from: mine, assumed or from the map. | 18 sites and 18 links, each link routed over the roads with its time and distance. |
| 3 | 1:00 | Open **Categories**, then **Vehicles**. Click the link from Hoskote dairy to a distribution centre. | Three kinds of goods: ambient, chilled and frozen. Chilled keeps ten days and goes by refrigerated truck. The two dairies supply only chilled goods; Bidadi foods supplies the rest. | The link's card says its chilled goods go by refrigerated truck. |
| 4 | 0:45 | **Build model**. Then **Show in Konjugate**, zoom in on one store and its stock room, and come back. Seen whole, the canvas names the most connected nodes and leaves out the labels that would overlap; zooming in brings the rest back (Konjugate after 1.1.10; before that the labels pile over each other, so stay zoomed in). | This is not a picture: it is a model, one copy of the network for each kind of goods, and every pallet in it is accounted for. | About 2 seconds: 134 nodes and 708 relationships. A note for each category says the stores' sales were scaled to what the suppliers supply (the file's figures do not agree exactly). |
| 5 | 1:30 | Scenarios, **Supplier** tab: Hoskote dairy, makes **80**% less, for **10** days, its warehouses **wait for it**. **Run the scenario**. Switch the map between **Scenario** and **Baseline**. | The same days are run twice, with and without the trouble, and compared. It is a comparison, not a forecast. | About 13 seconds. No store ran out, and 36 pallets of Chilled sales were lost, worth 35,781: the headline names the stores that ran short of Chilled and the longest, where the trial's wording (before days short were counted) said only that the sales were lost. The table by category shows the loss is all Chilled. |
| 6 | 1:00 | Change to **order what it cannot make from their other suppliers** and run again. | Ordering elsewhere helps only where there is an elsewhere. | The same loss as before: Bommasandra DC has one dairy only, and the result says it has no other supplier of Chilled. |
| 7 | 1:15 | Drag from the handle of Doddaballapur dairy to Bommasandra DC to link them (or press `L` and click it). **Build model** and run the same scenario again. | One more link, the same trouble. | Read the difference off the screen. Doddaballapur dairy can make 30 pallets a day and is asked for 5. **This step needs the Konjugate release after 1.1.10.** A reviewer ran it on 1.1.10 and got "no sales were lost" because the engine had dropped the shortage, not because the link helped; that is fixed in Konjugate, and the window now says when a run is its baseline's to the last digit. |
| 8 | 1:30 | **Weakest link** tab: tick each supplier and each warehouse, **Run the scenario**. | Each failure is run on its own for the same days, and they are ranked by what they lose. Which is likeliest is not the model's to say. | In the trial (before scene 7's link) five failures took 83 seconds, and Bommasandra DC down was worst, losing 425,985. With the new link there are as many failures to run; the order may differ. |

## If there is time

Each of these is one change and one run. None was tried on this network.

- **Hours.** On a store's card set **Receives** from 6 to 10. On the **Vehicles** list give the mini-van hours of 8 to 20. Run **As planned**: goods wait at a closed door, and the run shows whether the store is restocked in time.
- **A festival.** Under **Holidays and peaks** add one that raises demand for a few days and closes the suppliers. **As planned** then shows what the festival costs, and holding more cover at the stores shows what that saves.
- **A new warehouse.** Place a warehouse near Whitefield, tick **A candidate** on its card, link it to a supplier and to the eastern stores, and run **New site**: the network as it is and the network with it open, in normal weeks and with Bommasandra DC down.
- **A backup.** Link Nelamangala DC to Bommasandra DC and tick **A backup** on the link's card: it carries nothing until Bommasandra DC orders elsewhere.

## What to say plainly

- The sites, their sales and the value of a pallet are invented. Nothing shown is a forecast of anything.
- Roads never congest in the model: a travel time is the map's, or the user's own from a file.
- A category's idle vehicles on a link do not carry another category's goods.
- More limits are listed in [handover.md](handover.md), under *Known open items*.
