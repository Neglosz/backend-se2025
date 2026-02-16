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
        if (bucket !== 'customers') return urlOrPath; // Only sign customers for now as it is private

        let path = urlOrPath;
        // Extract path if it's a full URL
        if (urlOrPath.includes(`/object/public/${bucket}/`)) {
            path = urlOrPath.split(`/object/public/${bucket}/`)[1];
        }

        const { data, error } = await supabaseAdmin
            .storage
            .from(bucket)
            .createSignedUrl(path, 3600); // 1 hour expiry

        if (error) {
            console.error(`Error signing URL for ${path}:`, error);
            return urlOrPath; // Fallback to original
        }

        return data.signedUrl;
    }

    return {
        checkStoreAccess,
        signUrlIfNeeded
    };
};

module.exports = { createStoreService };
