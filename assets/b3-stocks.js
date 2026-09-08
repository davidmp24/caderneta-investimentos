/**
 * CADERNETA DE INVESTIMENTOS
 * Base de dados local de ativos da B3 (Ações, FIIs, ETFs)
 * Custo zero, funciona offline. Métricas fundamentalistas e valuation de referência.
 */

const B3_STOCKS = [
  // ── AÇÕES ──────────────────────────────────────────────────────────
  {
    ticker: "PETR4", name: "Petrobras PN", type: "STOCK", sector: "Petróleo e Gás",
    lpa: 8.92, vpa: 29.80, dy: 14.80, pl: 4.24, pvp: 1.27, roe: 30.1, netMargin: 24.5,
    divAnual: 5.60, targetPrice: 46.50, min52: 32.10, max52: 42.80,
    desc: "Líder em exploração e produção de petróleo no pré-sal com forte geração de caixa e dividendos."
  },
  {
    ticker: "PETR3", name: "Petrobras ON", type: "STOCK", sector: "Petróleo e Gás",
    lpa: 8.92, vpa: 29.80, dy: 14.50, pl: 4.50, pvp: 1.35, roe: 30.1, netMargin: 24.5,
    divAnual: 5.60, targetPrice: 48.00, min52: 34.00, max52: 44.50,
    desc: "Ações ordinárias com direito a voto da maior petroleira integrada do Brasil."
  },
  {
    ticker: "VALE3", name: "Vale S.A.", type: "STOCK", sector: "Mineração",
    lpa: 9.15, vpa: 43.20, dy: 8.90, pl: 6.68, pvp: 1.41, roe: 21.8, netMargin: 21.2,
    divAnual: 5.45, targetPrice: 78.00, min52: 54.20, max52: 74.90,
    desc: "Uma das maiores mineradoras de minério de ferro e níquel de alta qualidade do mundo."
  },
  {
    ticker: "BBAS3", name: "Banco do Brasil S.A.", type: "STOCK", sector: "Bancos",
    lpa: 6.28, vpa: 35.40, dy: 9.65, pl: 3.58, pvp: 0.64, roe: 21.2, netMargin: 14.8,
    divAnual: 2.17, targetPrice: 34.00, min52: 21.10, max52: 30.40,
    desc: "Maior instituição financeira do agronegócio com rentabilidade de banco privado e valuation atrativo."
  },
  {
    ticker: "BBSE3", name: "BB Seguridade", type: "STOCK", sector: "Seguros",
    lpa: 3.95, vpa: 6.20, dy: 9.10, pl: 10.67, pvp: 6.80, roe: 64.5, netMargin: 87.2,
    divAnual: 3.84, targetPrice: 48.00, min52: 31.50, max52: 43.60,
    desc: "Líder em seguros rurais e previdência com altíssimo retorno sobre patrimônio (ROE > 60%) e payout elevado."
  },
  {
    ticker: "ITUB4", name: "Itaú Unibanco PN", type: "STOCK", sector: "Bancos",
    lpa: 3.80, vpa: 21.30, dy: 7.20, pl: 9.10, pvp: 1.62, roe: 21.5, netMargin: 17.6,
    divAnual: 2.49, targetPrice: 42.00, min52: 28.50, max52: 36.90,
    desc: "Maior banco privado da América Latina, referência em gestão de risco, tecnologia e consistência de lucros."
  },
  {
    ticker: "ITUB3", name: "Itaú Unibanco ON", type: "STOCK", sector: "Bancos",
    lpa: 3.80, vpa: 21.30, dy: 6.80, pl: 8.60, pvp: 1.54, roe: 21.5, netMargin: 17.6,
    divAnual: 2.25, targetPrice: 38.00, min52: 26.00, max52: 34.00,
    desc: "Ação ordinária do Itaú Unibanco, com desconto histórico em relação à PN."
  },
  {
    ticker: "ITSA4", name: "Itaúsa PN", type: "STOCK", sector: "Holdings",
    lpa: 1.48, vpa: 9.40, dy: 8.50, pl: 7.10, pvp: 1.12, roe: 16.5, netMargin: 96.0,
    divAnual: 0.89, targetPrice: 13.50, min52: 9.10, max52: 11.20,
    desc: "Holding de investimentos com participação no Itaú Unibanco, CCR, Aegea, Alpargatas e Dexco com desconto de holding."
  },
  {
    ticker: "BBDC4", name: "Bradesco PN", type: "STOCK", sector: "Bancos",
    lpa: 1.65, vpa: 16.20, dy: 6.90, pl: 8.66, pvp: 0.88, roe: 11.5, netMargin: 9.8,
    divAnual: 0.99, targetPrice: 17.50, min52: 12.10, max52: 16.40,
    desc: "Segundo maior banco privado nacional, em fase de reestruturação de crédito e expansão digital."
  },
  {
    ticker: "BBDC3", name: "Bradesco ON", type: "STOCK", sector: "Bancos",
    lpa: 1.65, vpa: 16.20, dy: 7.30, pl: 7.80, pvp: 0.80, roe: 11.5, netMargin: 9.8,
    divAnual: 0.95, targetPrice: 16.00, min52: 11.00, max52: 15.00,
    desc: "Ação ordinária do Banco Bradesco negociando abaixo do seu valor patrimonial contábil."
  },
  {
    ticker: "TAEE11", name: "Taesa", type: "STOCK", sector: "Energia Elétrica",
    lpa: 3.42, vpa: 21.10, dy: 9.80, pl: 12.14, pvp: 1.97, roe: 17.2, netMargin: 42.5,
    divAnual: 4.07, targetPrice: 44.00, min52: 33.50, max52: 42.60,
    desc: "Transmissora pura de energia elétrica com contratos de concessão reajustados pela inflação (IGP-M/IPCA)."
  },
  {
    ticker: "TRPL4", name: "ISA Cteep", type: "STOCK", sector: "Energia Elétrica",
    lpa: 4.10, vpa: 27.80, dy: 8.70, pl: 6.75, pvp: 1.00, roe: 15.4, netMargin: 44.2,
    divAnual: 2.41, targetPrice: 32.50, min52: 22.80, max52: 29.50,
    desc: "Responsável pelo transporte de 30% de toda a energia elétrica do país com fluxo de caixa previsível."
  },
  {
    ticker: "CMIG4", name: "CEMIG PN", type: "STOCK", sector: "Energia Elétrica",
    lpa: 2.15, vpa: 10.40, dy: 11.40, pl: 5.23, pvp: 1.08, roe: 21.0, netMargin: 16.5,
    divAnual: 1.28, targetPrice: 14.50, min52: 9.80, max52: 12.90,
    desc: "Companhia energética integrada de Minas Gerais com forte histórico de proventos e eficiência operacional."
  },
  {
    ticker: "CPLE6", name: "Copel", type: "STOCK", sector: "Energia Elétrica",
    lpa: 1.05, vpa: 8.10, dy: 7.60, pl: 9.20, pvp: 1.20, roe: 13.8, netMargin: 14.2,
    divAnual: 0.74, targetPrice: 12.00, min52: 8.20, max52: 10.90,
    desc: "Companhia paranaense de energia recém-privatizada com ganhos expressivos de eficiência e governança."
  },
  {
    ticker: "EGIE3", name: "Engie Brasil", type: "STOCK", sector: "Energia Elétrica",
    lpa: 3.75, vpa: 14.60, dy: 7.90, pl: 11.50, pvp: 2.95, roe: 26.2, netMargin: 29.5,
    divAnual: 3.42, targetPrice: 48.00, min52: 38.00, max52: 45.80,
    desc: "Maior geradora privada de energia 100% renovável do Brasil com excelência comprovada em alocação de capital."
  },
  {
    ticker: "AURE3", name: "Auren Energia", type: "STOCK", sector: "Energia Elétrica",
    lpa: 1.60, vpa: 13.20, dy: 8.80, pl: 7.50, pvp: 0.91, roe: 12.5, netMargin: 19.8,
    divAnual: 1.05, targetPrice: 15.50, min52: 10.20, max52: 14.30,
    desc: "Uma das principais plataformas de geração e comercialização de energia renovável da América Latina."
  },
  {
    ticker: "UNIP6", name: "Unipar Carbocloro", type: "STOCK", sector: "Petroquímica",
    lpa: 8.40, vpa: 38.50, dy: 9.80, pl: 6.78, pvp: 1.48, roe: 24.5, netMargin: 18.2,
    divAnual: 5.58, targetPrice: 75.00, min52: 50.50, max52: 68.90,
    desc: "Líder na produção de cloro/soda e segunda maior em PVC na América Latina com alta capacidade de pagamento de dividendos."
  },
  {
    ticker: "SANB4", name: "Santander Brasil PN", type: "STOCK", sector: "Bancos",
    lpa: 1.70, vpa: 14.10, dy: 7.40, pl: 8.84, pvp: 1.07, roe: 14.5, netMargin: 12.8,
    divAnual: 1.11, targetPrice: 18.50, min52: 13.20, max52: 17.30,
    desc: "Braço brasileiro do grupo Santander, focado em crédito consignado, agronegócio e alta renda."
  },
  {
    ticker: "SANB11", name: "Santander Brasil Unit", type: "STOCK", sector: "Bancos",
    lpa: 3.40, vpa: 28.20, dy: 7.50, pl: 8.70, pvp: 1.05, roe: 14.5, netMargin: 12.8,
    divAnual: 2.22, targetPrice: 36.00, min52: 26.50, max52: 32.80,
    desc: "Units compostas por ações ON e PN do Banco Santander Brasil."
  },
  {
    ticker: "KLBN4", name: "Klabin PN", type: "STOCK", sector: "Papel e Celulose",
    lpa: 0.46, vpa: 2.30, dy: 7.80, pl: 8.37, pvp: 1.67, roe: 21.0, netMargin: 15.6,
    divAnual: 0.30, targetPrice: 5.20, min52: 3.40, max52: 4.80,
    desc: "Maior produtora e exportadora de papéis para embalagens e soluções sustentáveis de celulose do Brasil."
  },
  {
    ticker: "KLBN11", name: "Klabin Unit", type: "STOCK", sector: "Papel e Celulose",
    lpa: 2.30, vpa: 11.50, dy: 7.80, pl: 8.35, pvp: 1.67, roe: 21.0, netMargin: 15.6,
    divAnual: 1.50, targetPrice: 26.00, min52: 17.50, max52: 24.20,
    desc: "Units da Klabin com fluxo de receita dolarizado e resiliência cíclica."
  },
  {
    ticker: "SUZB3", name: "Suzano S.A.", type: "STOCK", sector: "Papel e Celulose",
    lpa: 6.80, vpa: 38.00, dy: 5.50, pl: 8.41, pvp: 1.50, roe: 19.5, netMargin: 20.4,
    divAnual: 3.15, targetPrice: 72.00, min52: 46.50, max52: 62.80,
    desc: "Maior produtora mundial de celulose de eucalipto com o menor custo de produção do planeta."
  },
  {
    ticker: "IRBR3", name: "IRB Brasil Re", type: "STOCK", sector: "Seguros",
    lpa: 5.20, vpa: 52.00, dy: 5.20, pl: 11.96, pvp: 1.20, roe: 10.8, netMargin: 7.5,
    divAnual: 3.23, targetPrice: 75.00, min52: 36.20, max52: 65.00,
    desc: "Líder em resseguros na América Latina em pleno ciclo de recuperação de margens e rentabilidade técnica."
  },
  {
    ticker: "WEGE3", name: "WEG S.A.", type: "STOCK", sector: "Máquinas e Motores",
    lpa: 1.42, vpa: 4.30, dy: 2.10, pl: 36.90, pvp: 12.18, roe: 35.8, netMargin: 17.8,
    divAnual: 1.10, targetPrice: 60.00, min52: 34.00, max52: 56.40,
    desc: "Multinacional brasileira de excelência global em motores elétricos, automação, tintas e transição energética."
  },
  {
    ticker: "PRIO3", name: "PRIO S.A.", type: "STOCK", sector: "Petróleo e Gás",
    lpa: 6.80, vpa: 21.50, dy: 0.00, pl: 6.88, pvp: 2.17, roe: 34.5, netMargin: 46.2,
    divAnual: 0.00, targetPrice: 65.00, min52: 38.00, max52: 52.40,
    desc: "Maior petroleira independente do Brasil focada em eficiência máxima e revitalização de campos maduros."
  },
  {
    ticker: "B3SA3", name: "B3 S.A.", type: "STOCK", sector: "Serviços Financeiros",
    lpa: 0.85, vpa: 3.80, dy: 6.20, pl: 12.88, pvp: 2.88, roe: 23.4, netMargin: 48.0,
    divAnual: 0.68, targetPrice: 14.50, min52: 9.80, max52: 13.90,
    desc: "Bolsa oficial do Brasil com monopólio de infraestrutura financeira, clearing, custódia e balcão."
  },
  {
    ticker: "ABEV3", name: "Ambev S.A.", type: "STOCK", sector: "Bebidas",
    lpa: 0.98, vpa: 5.60, dy: 6.40, pl: 12.60, pvp: 2.20, roe: 18.2, netMargin: 18.5,
    divAnual: 0.79, targetPrice: 16.00, min52: 11.10, max52: 14.80,
    desc: "Líder incontestável no mercado de cervejas e bebidas na América Latina com geração de caixa robusta."
  },
  {
    ticker: "RENT3", name: "Localiza Hertz", type: "STOCK", sector: "Aluguel de Veículos",
    lpa: 3.10, vpa: 29.50, dy: 4.80, pl: 14.45, pvp: 1.52, roe: 12.8, netMargin: 7.2,
    divAnual: 2.15, targetPrice: 62.00, min52: 38.50, max52: 58.00,
    desc: "Maior empresa de aluguel e gestão de frotas de automóveis da América do Sul."
  },
  {
    ticker: "SBSP3", name: "Sabesp", type: "STOCK", sector: "Saneamento",
    lpa: 5.80, vpa: 48.00, dy: 3.80, pl: 15.77, pvp: 1.90, roe: 14.2, netMargin: 22.1,
    divAnual: 3.47, targetPrice: 115.00, min52: 60.50, max52: 96.00,
    desc: "Maior companhia de saneamento das Américas recém-privatizada com ambicioso plano de universalização."
  },
  {
    ticker: "LREN3", name: "Lojas Renner", type: "STOCK", sector: "Varejo",
    lpa: 1.35, vpa: 10.80, dy: 4.90, pl: 12.48, pvp: 1.56, roe: 13.0, netMargin: 8.5,
    divAnual: 0.83, targetPrice: 22.00, min52: 13.50, max52: 19.80,
    desc: "Líder de varejo de moda no Brasil com ecossistema digital integrado e braço de serviços financeiros."
  },
  {
    ticker: "MGLU3", name: "Magazine Luiza", type: "STOCK", sector: "Varejo",
    lpa: -0.15, vpa: 12.40, dy: 0.00, pl: -59.0, pvp: 0.72, roe: -1.2, netMargin: -0.8,
    divAnual: 0.00, targetPrice: 12.50, min52: 7.50, max52: 14.20,
    desc: "Plataforma multicanal de varejo físico e comércio eletrônico com forte presença nacional."
  },
  {
    ticker: "GGBR4", name: "Gerdau PN", type: "STOCK", sector: "Siderurgia",
    lpa: 2.80, vpa: 25.40, dy: 6.80, pl: 6.80, pvp: 0.75, roe: 12.5, netMargin: 9.8,
    divAnual: 1.29, targetPrice: 25.00, min52: 16.80, max52: 23.50,
    desc: "Maior produtora brasileira de aço e uma das principais fornecedoras de aços longos nas Américas."
  },
  {
    ticker: "CSNA3", name: "CSN Siderúrgica", type: "STOCK", sector: "Siderurgia",
    lpa: 1.40, vpa: 15.20, dy: 7.20, pl: 8.50, pvp: 0.78, roe: 10.2, netMargin: 6.5,
    divAnual: 0.86, targetPrice: 16.00, min52: 10.50, max52: 16.80,
    desc: "Grupo siderúrgico integrado com operações em mineração, cimento, logística e energia."
  },
  {
    ticker: "EMBR3", name: "Embraer S.A.", type: "STOCK", sector: "Aeronáutica",
    lpa: 2.10, vpa: 26.50, dy: 1.50, pl: 24.50, pvp: 1.94, roe: 9.8, netMargin: 6.0,
    divAnual: 0.77, targetPrice: 62.00, min52: 22.00, max52: 55.00,
    desc: "Terceira maior fabricante global de jatos comerciais e líder absoluta no segmento de aviação executiva."
  },
  {
    ticker: "RADL3", name: "Raia Drogasil", type: "STOCK", sector: "Farmacêutico",
    lpa: 0.72, vpa: 3.80, dy: 1.80, pl: 34.20, pvp: 6.47, roe: 19.8, netMargin: 3.2,
    divAnual: 0.44, targetPrice: 30.00, min52: 23.50, max52: 29.40,
    desc: "Líder absoluta do varejo farmacêutico no Brasil com mais de 3.000 lojas e forte fidelização de clientes."
  },
  {
    ticker: "ELET3", name: "Eletrobras ON", type: "STOCK", sector: "Energia Elétrica",
    lpa: 3.20, vpa: 46.50, dy: 3.20, pl: 12.10, pvp: 0.83, roe: 7.5, netMargin: 18.0,
    divAnual: 1.24, targetPrice: 54.00, min52: 34.00, max52: 44.20,
    desc: "Maior empresa de geração e transmissão de energia elétrica da América Latina."
  },
  {
    ticker: "VBBR3", name: "Vibra Energia", type: "STOCK", sector: "Combustíveis",
    lpa: 2.30, vpa: 13.80, dy: 6.50, pl: 10.20, pvp: 1.70, roe: 18.0, netMargin: 3.1,
    divAnual: 1.53, targetPrice: 29.00, min52: 19.50, max52: 27.20,
    desc: "Líder no mercado brasileiro de distribuição de combustíveis e lubrificantes (postos Petrobras)."
  },
  {
    ticker: "UGPA3", name: "Ultrapar", type: "STOCK", sector: "Combustíveis",
    lpa: 2.10, vpa: 11.20, dy: 5.80, pl: 11.40, pvp: 2.14, roe: 19.5, netMargin: 2.2,
    divAnual: 1.39, targetPrice: 28.00, min52: 18.00, max52: 26.50,
    desc: "Controladora dos postos Ipiranga, Ultragaz e Ultracargo com sólida eficiência logística."
  },
  {
    ticker: "TIMS3", name: "TIM S.A.", type: "STOCK", sector: "Telecomunicações",
    lpa: 1.30, vpa: 11.40, dy: 7.20, pl: 13.40, pvp: 1.53, roe: 12.0, netMargin: 13.2,
    divAnual: 1.25, targetPrice: 20.50, min52: 14.80, max52: 19.20,
    desc: "Líder em cobertura 5G no país com forte expansão de margens e rentabilidade pós-incorporação da Oi Móvel."
  },
  {
    ticker: "VIVT3", name: "Vivo / Telefônica", type: "STOCK", sector: "Telecomunicações",
    lpa: 3.35, vpa: 43.50, dy: 7.80, pl: 15.50, pvp: 1.19, roe: 8.2, netMargin: 10.8,
    divAnual: 4.05, targetPrice: 58.00, min52: 44.50, max52: 54.00,
    desc: "Líder em telecomunicações móveis e fibra óptica residencial no Brasil, pagadora histórica de dividendos."
  },

  // ── FIIS & FIAGROS ──────────────────────────────────────────────────
  {
    ticker: "HGLG11", name: "CSHG Logística", type: "FII", sector: "Logística",
    lpa: 14.50, vpa: 158.20, dy: 8.40, pl: 11.39, pvp: 1.04, roe: 9.5, netMargin: 88.0,
    divAnual: 13.88, targetPrice: 175.00, min52: 152.00, max52: 172.00,
    desc: "Um dos maiores e mais consolidados FIIs de galpões logísticos classe A do Brasil, gerido pelo Credit Suisse/Patria."
  },
  {
    ticker: "BTLG11", name: "BTG Pactual Logística", type: "FII", sector: "Logística",
    lpa: 9.80, vpa: 102.50, dy: 9.20, pl: 10.34, pvp: 0.99, roe: 9.8, netMargin: 90.0,
    divAnual: 9.33, targetPrice: 112.00, min52: 95.00, max52: 106.00,
    desc: "Fundo imobiliário de galpões logísticos de alto padrão com localização estratégica no raio 30km de São Paulo."
  },
  {
    ticker: "XPLG11", name: "XP Log", type: "FII", sector: "Logística",
    lpa: 9.20, vpa: 110.80, dy: 8.90, pl: 11.39, pvp: 0.95, roe: 8.5, netMargin: 87.0,
    divAnual: 9.33, targetPrice: 118.00, min52: 98.00, max52: 112.00,
    desc: "Fundo focado em galpões logísticos com contratos atípicos de longo prazo para grandes varejistas e e-commerce."
  },
  {
    ticker: "MXRF11", name: "Maxi Renda", type: "FII", sector: "Papel / CRI",
    lpa: 1.25, vpa: 9.85, dy: 12.40, pl: 8.12, pvp: 1.03, roe: 12.8, netMargin: 94.0,
    divAnual: 1.26, targetPrice: 10.80, min52: 9.70, max52: 11.10,
    desc: "O FII com maior número de cotistas do Brasil, focado em Certificados de Recebíveis Imobiliários (CRI)."
  },
  {
    ticker: "KNIP11", name: "Kinea IP", type: "FII", sector: "Papel / CRI",
    lpa: 11.20, vpa: 98.40, dy: 11.80, pl: 8.44, pvp: 0.96, roe: 11.5, netMargin: 96.0,
    divAnual: 11.15, targetPrice: 105.00, min52: 89.00, max52: 99.50,
    desc: "Fundo de papel gerido pela Kinea com carteira de CRIs atrelados à inflação (IPCA+) e devedores de primeiríssima linha."
  },
  {
    ticker: "KNCR11", name: "Kinea Rendimentos", type: "FII", sector: "Papel / CRI",
    lpa: 12.40, vpa: 102.10, dy: 12.60, pl: 8.37, pvp: 1.02, roe: 12.4, netMargin: 95.0,
    divAnual: 13.08, targetPrice: 108.00, min52: 98.00, max52: 106.50,
    desc: "FII indexado ao CDI, ideal para momentos de taxa Selic elevada com excelente previsibilidade de proventos."
  },
  {
    ticker: "XPML11", name: "XP Malls", type: "FII", sector: "Shopping Centers",
    lpa: 10.50, vpa: 115.60, dy: 9.10, pl: 10.71, pvp: 0.97, roe: 9.3, netMargin: 86.0,
    divAnual: 10.24, targetPrice: 125.00, min52: 104.00, max52: 119.00,
    desc: "Maior fundo imobiliário de shopping centers do mercado, com participações em shoppings líderes em capitais."
  },
  {
    ticker: "VISC11", name: "Vinci Shopping Centers", type: "FII", sector: "Shopping Centers",
    lpa: 10.80, vpa: 122.40, dy: 8.80, pl: 11.00, pvp: 0.96, roe: 9.0, netMargin: 88.0,
    divAnual: 10.40, targetPrice: 130.00, min52: 108.00, max52: 125.00,
    desc: "Portfólio diversificado de shopping centers consolidados e resilientes em todas as regiões brasileiras."
  },
  {
    ticker: "KNRI11", name: "Kinea Renda Imobiliária", type: "FII", sector: "Renda Mista",
    lpa: 12.80, vpa: 159.00, dy: 8.60, pl: 11.60, pvp: 0.94, roe: 8.5, netMargin: 89.0,
    divAnual: 12.80, targetPrice: 170.00, min52: 138.00, max52: 165.00,
    desc: "Fundo híbrido histórico que combina prédios corporativos nobres em São Paulo com galpões logísticos."
  },
  {
    ticker: "TRXF11", name: "TRX Real Estate", type: "FII", sector: "Varejo",
    lpa: 11.50, vpa: 105.00, dy: 10.20, pl: 9.10, pvp: 0.99, roe: 10.8, netMargin: 90.0,
    divAnual: 10.80, targetPrice: 118.00, min52: 98.00, max52: 112.00,
    desc: "Foco em imóveis urbanos alugados para gigantes do varejo (Assaí, Pão de Açúcar, Leroy Merlin) com contratos longos."
  },

  // ── ETFs & BDRs ────────────────────────────────────────────────────
  {
    ticker: "BOVA11", name: "iShares Ibovespa ETF", type: "ETF", sector: "Índice Ibovespa",
    lpa: null, vpa: null, dy: 0.00, pl: 8.20, pvp: 1.45, roe: 16.0, netMargin: null,
    divAnual: 0.00, targetPrice: 155.00, min52: 118.00, max52: 138.00,
    desc: "Principal ETF que replica o Índice Bovespa, reunindo as maiores e mais líquidas empresas do Brasil."
  },
  {
    ticker: "IVVB11", name: "iShares S&P 500 ETF (BDR)", type: "ETF", sector: "Índice S&P 500",
    lpa: null, vpa: null, dy: 0.00, pl: 24.50, pvp: 4.80, roe: 22.0, netMargin: null,
    divAnual: 0.00, targetPrice: 395.00, min52: 280.00, max52: 365.00,
    desc: "Acesso direto em reais às 500 maiores empresas dos Estados Unidos (Apple, Microsoft, Nvidia, Amazon)."
  },
  {
    ticker: "HASH11", name: "Hashdex Nasdaq Crypto ETF", type: "ETF", sector: "Criptoativos",
    lpa: null, vpa: null, dy: 0.00, pl: null, pvp: null, roe: null, netMargin: null,
    divAnual: 0.00, targetPrice: 85.00, min52: 35.00, max52: 78.00,
    desc: "Primeiro ETF de criptoativos do Brasil, replicando a cesta de ativos institucionais Nasdaq Crypto Index."
  },
  {
    ticker: "SMAL11", name: "iShares Small Cap ETF", type: "ETF", sector: "Small Caps",
    lpa: null, vpa: null, dy: 0.00, pl: 10.50, pvp: 1.20, roe: 12.0, netMargin: null,
    divAnual: 0.00, targetPrice: 125.00, min52: 88.00, max52: 110.00,
    desc: "Carteira diversificada de empresas brasileiras com alto potencial de crescimento fora do radar das grandes blue chips."
  },
  {
    ticker: "AAPL34", name: "Apple Inc. (BDR)", type: "ETF", sector: "Tecnologia EUA",
    lpa: 6.80, vpa: 4.50, dy: 0.60, pl: 32.0, pvp: 45.0, roe: 145.0, netMargin: 25.0,
    divAnual: 0.45, targetPrice: 72.00, min52: 44.00, max52: 68.00,
    desc: "BDR da maior empresa de tecnologia de consumo do planeta (iPhone, Mac, Services e Apple Intelligence)."
  },
  {
    ticker: "NVDC34", name: "NVIDIA Corp. (BDR)", type: "ETF", sector: "Tecnologia EUA",
    lpa: 3.20, vpa: 2.80, dy: 0.10, pl: 48.0, pvp: 42.0, roe: 98.0, netMargin: 55.0,
    divAnual: 0.08, targetPrice: 95.00, min52: 32.00, max52: 88.00,
    desc: "Líder global inconteste em aceleradores de Inteligência Artificial e chips gráficos."
  },
  {
    ticker: "MSFT34", name: "Microsoft Corp. (BDR)", type: "ETF", sector: "Tecnologia EUA",
    lpa: 11.50, vpa: 32.0, dy: 0.80, pl: 34.0, pvp: 12.0, roe: 38.0, netMargin: 35.0,
    divAnual: 0.75, targetPrice: 115.00, min52: 75.00, max52: 102.00,
    desc: "Pioneira em nuvem corporativa (Azure), software produtivo (Office) e Inteligência Artificial com a OpenAI."
  }
];

// Setores únicos para filtro
const B3_SECTORS = [...new Set(B3_STOCKS.map(s => s.sector))].sort();

/**
 * Funções de Cálculo Fundamentalista & Preço Justo
 */

/**
 * Preço Justo de Graham: V = sqrt(22.5 * LPA * VPA)
 * Aplicável para ações com lucros e patrimônio positivos
 */
function calculateGrahamPrice(lpa, vpa) {
  if (!lpa || !vpa || lpa <= 0 || vpa <= 0) return null;
  return Math.sqrt(22.5 * lpa * vpa);
}

/**
 * Preço Teto de Décio Bazin: Preço Teto = Dividendo Anual / 0.06
 * Retorna o valor máximo a pagar para obter 6% a.a. de Dividend Yield
 */
function calculateBazinPrice(divAnual) {
  if (!divAnual || divAnual <= 0) return null;
  return divAnual / 0.06;
}

/**
 * Projeção de Valorização (Upside %)
 * Upside = ((Preço Justo - Preço Atual) / Preço Atual) * 100
 */
function calculateUpsidePct(currentPrice, fairPrice) {
  if (!currentPrice || !fairPrice || currentPrice <= 0) return null;
  return ((fairPrice - currentPrice) / currentPrice) * 100;
}
