/**
 * Despertador do coletor do Em Alta (Google Apps Script).
 *
 * Por quê: o agendamento do GitHub Actions não disparou para este repo (02/nov/2026).
 * O Apps Script tem gatilho de hora em hora confiável e só pede ao GitHub para rodar o coletor,
 * do mesmo jeito que o botão "Run workflow".
 *
 * Instalação (uma vez):
 *   1. Configurações do projeto > Propriedades do script > adicionar GITHUB_TOKEN
 *      (token fine-grained com acesso só ao repo bernardomcr/unbubble e permissão Actions: Read and write).
 *   2. Rodar a função `testar` (autoriza o script e dispara o coletor uma vez).
 *   3. Rodar a função `instalarGatilho` (passa a disparar de hora em hora).
 *
 * Se algo falhar, a função lança erro e o Google manda e-mail de aviso de falha.
 */

const REPO = 'bernardomcr/unbubble';
const WORKFLOW = 'coletor.yml';

function dispararColetor() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    throw new Error('Falta a propriedade GITHUB_TOKEN nas configurações do projeto.');
  }
  const resposta = UrlFetchApp.fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      payload: JSON.stringify({ ref: 'main' }),
      muteHttpExceptions: true,
    }
  );
  const codigo = resposta.getResponseCode();
  if (codigo !== 204) {
    // 401 = token inválido ou vencido; 403/404 = token sem permissão para este repo
    throw new Error(`GitHub respondeu ${codigo}: ${resposta.getContentText().slice(0, 300)}`);
  }
  console.log('Coletor disparado.');
}

function testar() {
  dispararColetor();
}

function instalarGatilho() {
  for (const g of ScriptApp.getProjectTriggers()) {
    if (g.getHandlerFunction() === 'dispararColetor') {
      ScriptApp.deleteTrigger(g);
    }
  }
  ScriptApp.newTrigger('dispararColetor').timeBased().everyHours(1).create();
  console.log('Gatilho de hora em hora instalado.');
}
