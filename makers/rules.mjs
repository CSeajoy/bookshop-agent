import { documents } from './data.generated.mjs';
import { indexDocument, matchRules } from '../rule-search.mjs';

const chunks = Object.entries(documents).flatMap(([name, content]) => indexDocument(name, content));
export const searchRules = query => matchRules(query, chunks);
