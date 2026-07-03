import { indiaDestinations } from "./destinations-india.js";
import { internationalDestinations } from "./destinations-international.js";

export const allDestinations = [
  ...indiaDestinations,
  ...internationalDestinations,
];
export { indiaDestinations, internationalDestinations };
