// Ficheiros JSON na pasta de dados: lidos com um valor por defeito quando não existem, escritos primeiro num .tmp e
// só depois postos no lugar, para uma escrita interrompida não deixar um ficheiro a meio.
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

module.exports = { readJson, writeJson, newId };
