const createStoreService = ({ supabaseAdmin }) => {
    async function checkStoreAccess(storeId, userId) {
        if (!storeId || !userId) return false;

        // 1. Check if Owner
        const { data: store } = await supabaseAdmin
            .from('stores')
            .select('owner_id')
            .eq('id', storeId)
            .single();

        if (store && store.owner_id === userId) return true;

        // 2. Check if Member/Manager
        const { data: member } = await supabaseAdmin
            .from('store_members')
            .select('role')
            .eq('store_id', storeId)
            .eq('user_id', userId)
            .single();

        if (member) return true;

        return false;
    }

    async function signUrlIfNeeded(urlOrPath, bucket) {
        if (!urlOrPath) return null;
        if (bucket !== 'customers') return urlOrPath;
        let path = urlOrPath;
        // Extract path if it's a full URL
        if (urlOrPath.includes(`/object/public/${bucket}/`)) {
            path = urlOrPath.split(`/object/public/${bucket}/`)[1];
        }
        // ✅ ของใหม่ (ดึง Public URL แทน)
        const { data } = supabaseAdmin
            .storage
            .from(bucket)
            .getPublicUrl(path);
        return data.publicUrl;
    }

    return {
        checkStoreAccess,
        signUrlIfNeeded
    };
};

module.exports = { createStoreService };
