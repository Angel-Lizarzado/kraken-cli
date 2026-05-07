/**
 * Divide un array en chunks de tamaño fijo.
 * @param {Array} arr - Array a dividir
 * @param {number} size - Tamaño de cada chunk (debe ser > 0)
 * @returns {Array[]} Array de chunks
 */
function chunkArray(arr, size) {
  if (!Array.isArray(arr) || size < 1) return [];
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

module.exports = { chunkArray };
