# Especificação Técnica do Sistema: Carteira & Watchlist PWA (Custo Zero)

## 1. Visão Geral e Propósito

Este documento descreve a arquitetura, regras de negócio e implementação de uma aplicação mobile offline-first para controle pessoal de carteira de investimentos e lista de monitoramento (watchlist/favoritos), com design e usabilidade inspirados na experiência do **Investidor10**.

### Premissas Fundamentais
1. **Custo Zero Real:** Sem servidores de backend dedicados, sem hospedagem paga e sem dependência de serviços pagos de banco de dados ou APIs restritivas.
2. **Privacidade e Autonomia:** Armazenamento local no dispositivo móvel do usuário (Local-First via `localStorage` e `IndexedDB`), sem envio de dados patrimoniais para servidores de terceiros.
3. **Execução Mobile Nativa via Navegador:** Aplicação PWA (*Progressive Web App*) em arquivo único ou estática, otimizada para visualização responsiva e fluida no Android (ex.: display AMOLED de alta taxa de atualização).
4. **Alimentação de Cotações Precisa:** Utilização de endpoints financeiros públicos e gratuitos para obtenção exata de preços (B3 e Cripto), eliminando o risco de alucinação ou latência de modelos de linguagem para dados numéricos.

---

## 2. Arquitetura e Stack Tecnológica

| Camada | Tecnologia Adotada | Justificativa |
| :--- | :--- | :--- |
| **Interface / Camada de Apresentação** | HTML5 Semântico + CSS3 Moderno (Variáveis CSS, CSS Grid/Flexbox) | Interface leve, sem *framework bloat*, carregamento instantâneo e suporte a Dark Mode puro (#0f172a / #000000). |
| **Lógica e Regras de Negócio** | JavaScript Vanilla (ES6+) | Execução sem dependência de transpiladores ou bundlers complexos; facilidade de manutenção em arquivo único. |
| **Persistência de Dados** | Web Storage API (`localStorage` / `IndexedDB`) | Armazenamento seguro no navegador móvel com retenção permanente no dispositivo. |
| **Portabilidade / Backup** | Mecanismo de Serialização JSON | Importação e exportação de backups integrais com um clique, permitindo sincronização manual via arquivos locais. |
| **Consumo de Cotações** | Fetch API assíncrono com APIs abertas | Consumo direto no cliente: **Binance Public API** (Cripto) e **Brapi / Proxy aberto de cotações B3**. |

---

## 3. Módulos Funcionais do Sistema

O sistema é dividido em três áreas principais de controle:

### 3.1. Módulo Carteira (Ativos Investidos)
Destinado ao controle manual e anotação dos aportes realizados:
* **Cadastro de Posição:**
  * Ticker do papel (ex.: `BBAS3`, `HGLG11`, `BTC`, `IVVB11`).
  * Categoria: `Ações`, `FIIs/Fiagros`, `ETFs/BDRs`, `Cripto`, `Renda Fixa`.
  * Quantidade total em custódia.
  * Preço Médio unitário de aquisição ($PM$).
  * Total investido calculado automaticamente: $\text{Custo Total} = \text{Quantidade} \times PM$.
* **Métricas em Tempo Real:**
  * Preço Atual de mercado (via API ou atualização manual).
  * Saldo Atual: $\text{Saldo} = \text{Quantidade} \times \text{Preço Atual}$.
  * Lucro/Prejuízo Nominal: $\text{Rentabilidade (R$)} = \text{Saldo} - \text{Custo Total}$.
  * Rentabilidade Percentual: $\text{Rentabilidade (\%)} = \left(\frac{\text{Preço Atual} - PM}{PM}\right) \times 100$.
  * Alocação Percentual: Peso percentual de cada ativo sobre o patrimônio total da carteira.

### 3.2. Módulo Favoritos / Radar (Watchlist)
Inspirado na lista de acompanhamento do Investidor10, permitindo monitorar papéis em estudo antes de comprar:
* **Cadastro de Ativo no Radar:**
  * Ticker e Categoria.
  * Preço Teto / Preço-Alvo de entrada (campo opcional configurável pelo usuário).
  * Preço Atual de mercado.
  * Margem de Segurança: Indicador visual se o ativo está cotado abaixo ou acima do Preço Teto estipulado.
  * Notas e anotações rápidas (ex.: motivos de tese de investimento, expectativas de dividendos).
* **Migração Facilitada:**
  * Botão de conversão direta de um item favorito em ativo investido da carteira, abrindo o modal de lançamento de compra.

### 3.3. Módulo de Gestão de Dados (Backup & Restauração)
* **Exportar Backup:** Gera e faz download de um arquivo `carteira_backup_YYYY-MM-DD.json` contendo todas as posições, histórico e favoritos.
* **Restaurar Backup:** Leitor de arquivo `.json` local que valida e restaura o estado integral da aplicação sem perdas.
* **Limpeza e Reset:** Opção de zerar a base local mediante confirmação explícita.

---

## 4. Modelo e Estrutura de Dados (JSON Schema)

O esquema unificado que o sistema deve manter no armazenamento local é o seguinte:

```json
{
  "version": "1.0.0",
  "lastUpdated": "2026-09-07T08:40:00Z",
  "settings": {
    "currency": "BRL",
    "theme": "dark",
    "autoRefreshQuotes": false
  },
  "portfolio": [
    {
      "id": "pos_001",
      "ticker": "BBAS3",
      "name": "Banco do Brasil S.A.",
      "type": "STOCK",
      "quantity": 250.0,
      "averagePrice": 22.15,
      "currentPrice": 22.53,
      "lastPriceUpdate": "2026-09-07T08:30:00Z",
      "notes": "Aporte com foco em dividendos recorrentes."
    },
    {
      "id": "pos_002",
      "ticker": "BTC",
      "name": "Bitcoin",
      "type": "CRYPTO",
      "quantity": 0.0452,
      "averagePrice": 380000.00,
      "currentPrice": 409800.00,
      "lastPriceUpdate": "2026-09-07T08:30:00Z",
      "notes": "Custódia própria em hardware wallet."
    }
  ],
  "watchlist": [
    {
      "id": "fav_001",
      "ticker": "HGLG11",
      "name": "CSHG Logística",
      "type": "FII",
      "targetPrice": 145.00,
      "currentPrice": 148.35,
      "lastPriceUpdate": "2026-09-07T08:30:00Z",
      "notes": "Aguardando correção para aporte em galpões de alta qualidade."
    }
  ]
}
```

---

## 5. Estratégia de Atualização de Cotações (Custo Zero)

Para evitar custos de infraestrutura e garantir alta confiabilidade matemática, o frontend consome diretamente endpoints públicos:

### 5.1. Criptomoedas (Bitcoin e outros)
* **Endpoint:** Binance Public API (Ticker Price)
* **Método:** `GET`
* **URL:** `https://api.binance.com/api/v3/ticker/price?symbol=BTCBRL`
* **Vantagens:** 100% gratuita, sem necessidade de autenticação/API Key, sem restrição de CORS e com resposta em milissegundos.
* **Tratamento:** Extrai `parseFloat(response.price)`.

### 5.2. Ações, FIIs e BDRs (B3)
* **Provedor 1 (Recomendado):** Brapi (`https://brapi.dev/api/quote/{tickers}?token=YOUR_FREE_TOKEN`)
  * Fornece dados consolidados da B3, cotação atual e variação percentual diária.
* **Provedor 2 (Alternativa Sem Chave):** Yahoo Finance via CORS Proxy público (ou endpoint aberto de cotações com sufixo `.SA`, ex.: `PETR4.SA`).
* **Fallback Manual:** Todo ativo permite a edição direta do Preço Atual por clique no valor, garantindo usabilidade mesmo em cenários sem conexão à internet.

---

## 6. Layout e Usabilidade Mobile (Diretrizes de UI/UX)

1. **Paleta de Cores e Estilo Visual:**
   * Fundo Principal: `#0a0f1d` (preto/chumbo profundo, otimizado para economia de bateria em telas AMOLED).
   * Superfície/Cards: `#161f36` com bordas sutis em `#263554`.
   * Cor de Destaque / Identidade: `#00b0ff` ou `#10b981` (verde investimento).
   * Indicadores de Lucro / Prejuízo: `#10b981` (alta/positivo) e `#ef4444` (baixa/negativo).
2. **Navegação:**
   * Barra de navegação inferior (*Bottom Navigation Bar*) fixa com 3 seções: **Carteira**, **Favoritos** e **Configurações/Backup**.
3. **Interações Touch:**
   * Botões com área de toque mínima de `48px x 48px` para evitar toques acidentais em tela móvel.
   * Feedback visual imediato ao cadastrar ou atualizar cotações com indicador discreto de carregamento.

---

## 7. Critérios de Conclusão do Desenvolvedor

O sistema será considerado concluído quando atender aos seguintes critérios de aceite:
* [ ] Permitir inclusão, edição e exclusão de ativos investidos com cálculo imediato de saldo e rentabilidade.
* [ ] Permitir inclusão, edição e exclusão de itens na lista de favoritos com preço teto e margem calculada.
* [ ] Botão "Atualizar Cotações" realizando requisições assíncronas em lote sem travar a interface.
* [ ] Exportação completa dos dados para arquivo `.json` funcional e restauração idêntica sem duplicação de IDs.
* [ ] Funcionamento completo em arquivo local único (HTML com scripts e estilos embutidos) executado no navegador Android.
