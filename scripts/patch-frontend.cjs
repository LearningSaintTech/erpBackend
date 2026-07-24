const fs = require('fs');
const root = 'c:/Users/PushkarLS68/erpFactory/frontend/src';

const typesPath = root + '/types/api.ts';
let types = fs.readFileSync(typesPath, 'utf8');
if (!types.includes('styleNumber?:')) {
  types = types.replace(
    'export interface DesignCollection {\n  _id: string;\n  name: string;',
    'export interface DesignCollection {\n  _id: string;\n  code?: string;\n  name: string;'
  );
  types = types.replace(
    '  availableQty?: number;\n}',
    '  availableQty?: number;\n  sizes?: { size: string; sku?: string }[];\n}'
  );
  types = types.replace(
    '  skuPrefix?: string;',
    '  skuPrefix?: string;\n  styleNumber?: string;\n  skuCodeInputs?: {\n    styleNu?: string;\n    gender?: string;\n    styleGender?: string;\n    productType?: string;\n    productTypeCode?: string;\n    fitType?: string;\n    collectionId?: string;\n  };'
  );
  fs.writeFileSync(typesPath, types);
}

const mfgPath = root + '/services/manufacturing.ts';
let mfg = fs.readFileSync(mfgPath, 'utf8');
if (!mfg.includes('styleNumber?:')) {
  mfg = mfg.replace('  skuPrefix?: string;', '  skuPrefix?: string;\n  styleNumber?: string;');
}
if (!mfg.includes('collectionId?: string')) {
  mfg = mfg.replace('export interface DesignListParams {', 'export interface DesignListParams {\n  collectionId?: string;');
}
if (!mfg.includes('regenerateSkus')) {
  mfg = mfg.replace(
    "  clone: (id: string) => api.post<{ data: Design }>(`/designs/${id}/clone`).then(unwrap),",
    "  clone: (id: string) => api.post<{ data: Design }>(`/designs/${id}/clone`).then(unwrap),\n  regenerateSkus: (id: string) => api.post<{ data: Design }>(`/designs/${id}/generate-sku`).then(unwrap),"
  );
  fs.writeFileSync(mfgPath, mfg);
}

const utilsPath = root + '/features/design/designFormUtils.ts';
let utils = fs.readFileSync(utilsPath, 'utf8');
if (!utils.includes('styleNumber: string')) {
  utils = utils.replace('  skuPrefix: string;', '  skuPrefix: string;\n  styleNumber: string;');
  utils = utils.replace("    skuPrefix: design.skuPrefix || '',", "    skuPrefix: design.skuPrefix || '',\n    styleNumber: design.styleNumber || '',");
  utils = utils.replace(
    '    colors: design.colorVariants?.length ? design.colorVariants : [emptyColor()],',
    '    colors: design.colorVariants?.length\n      ? design.colorVariants.map((c) => ({ ...c, sizes: c.sizes || [] }))\n      : [emptyColor()],'
  );
  utils = utils.replace(
    '    skuPrefix: state.skuPrefix.trim() || undefined,',
    '    skuPrefix: state.skuPrefix.trim() || undefined,\n    styleNumber: state.styleNumber.trim() || undefined,'
  );
  utils = utils.replace(
    "  { id: 'colors', label: 'Colors & Variants' },",
    "  { id: 'colors', label: 'Colors & Variants' },\n  { id: 'skus', label: 'SKU Matrix' },"
  );
  fs.writeFileSync(utilsPath, utils);
}

const pagePath = root + '/features/design/DesignFormPage.tsx';
let page = fs.readFileSync(pagePath, 'utf8');
if (!page.includes('SkuMatrixTab')) {
  page = page.replace(
    "import { VersionHistoryTab } from './tabs/VersionHistoryTab';",
    "import { VersionHistoryTab } from './tabs/VersionHistoryTab';\nimport { SkuMatrixTab } from './tabs/SkuMatrixTab';"
  );
  page = page.replace("  skuPrefix: '',", "  skuPrefix: '',\n  styleNumber: '',");
  page = page.replace('    versions: <VersionHistoryTab />,', '    skus: <SkuMatrixTab />,\n    versions: <VersionHistoryTab />,');
  page = page.replace(
    "if (!payload.title) throw new Error('Title is required');",
    "if (!payload.title) throw new Error('Title is required');\n      if (!payload.collectionId) throw new Error('Collection is required');"
  );
  fs.writeFileSync(pagePath, page);
}

const basicPath = root + '/features/design/tabs/BasicDetailsTab.tsx';
let basic = fs.readFileSync(basicPath, 'utf8');
if (!basic.includes('Style Number')) {
  basic = basic.replace('<span className={labelClass()}>SKU Prefix</span>', '<span className={labelClass()}>Product Type Code</span>');
  basic = basic.replace(
    '<input value={form.skuPrefix} onChange={(e) => set(\'skuPrefix\', e.target.value)} disabled={!editable} className={inputClass(editable)} placeholder="SHR" />\n      </label>\n      <label className="block">\n        <span className={labelClass()}>Category</span>',
    '<input value={form.skuPrefix} onChange={(e) => set(\'skuPrefix\', e.target.value)} disabled={!editable} className={inputClass(editable)} placeholder="SHR" />\n      </label>\n      <label className="block">\n        <span className={labelClass()}>Style Number</span>\n        <input value={form.styleNumber} onChange={(e) => set(\'styleNumber\', e.target.value)} disabled={!editable} className={inputClass(editable)} placeholder="KHM009" />\n      </label>\n      <label className="block">\n        <span className={labelClass()}>Category</span>'
  );
  basic = basic.replace('<span className={labelClass()}>Collection</span>', '<span className={labelClass()}>Collection *</span>');
  fs.writeFileSync(basicPath, basic);
}

const colorsPath = root + '/features/design/tabs/ColorVariantsTab.tsx';
let colors = fs.readFileSync(colorsPath, 'utf8');
if (!colors.includes('Color code')) {
  colors = colors.replace('placeholder="Color name"', 'placeholder="Color name *"');
  colors = colors.replace(
    '          <input\n            value={c.pantoneCode || \'\'}',
    '          <input\n            value={c.code || \'\'}\n            onChange={(e) => setForm((f) => ({ ...f, colors: f.colors.map((row, j) => j === i ? { ...row, code: e.target.value } : row) }))}\n            disabled={!editable}\n            placeholder="Color code (BL)"\n            className={inputClass(editable)}\n          />\n          <input\n            value={c.pantoneCode || \'\'}'
  );
  fs.writeFileSync(colorsPath, colors);
}

const designsPagePath = root + '/features/design/DesignsPage.tsx';
let designsPage = fs.readFileSync(designsPagePath, 'utf8');
if (!designsPage.includes('collectionFilter')) {
  designsPage = designsPage.replace(
    "  const [tagFilter, setTagFilter] = useState('');",
    "  const [tagFilter, setTagFilter] = useState('');\n  const [collectionFilter, setCollectionFilter] = useState('');"
  );
  designsPage = designsPage.replace(
    "  const { data: lookups } = useQuery({ queryKey: ['design-lookups'], queryFn: designApi.getLookups });",
    "  const { data: lookups } = useQuery({ queryKey: ['design-lookups'], queryFn: designApi.getLookups });\n  const { data: collections = [] } = useQuery({ queryKey: ['collections'], queryFn: designApi.listCollections });"
  );
  designsPage = designsPage.replace(
    "    queryKey: ['designs', statusFilter, categoryFilter, tagFilter],",
    "    queryKey: ['designs', statusFilter, categoryFilter, collectionFilter, tagFilter],"
  );
  designsPage = designsPage.replace(
    '      tags: tagFilter || undefined,\n    }),',
    '      tags: tagFilter || undefined,\n      collectionId: collectionFilter || undefined,\n    }),'
  );
  designsPage = designsPage.replace(
    '      <div className="mb-4 flex flex-wrap gap-3">',
    '      <div className="mb-4 flex flex-wrap gap-3">\n        <select value={collectionFilter} onChange={(e) => setCollectionFilter(e.target.value)} className="rounded border px-3 py-2 text-sm">\n          <option value="">All collections</option>\n          {collections.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}\n        </select>'
  );
  fs.writeFileSync(designsPagePath, designsPage);
}

console.log('frontend patched');
