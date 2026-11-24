package app.gameguidego.android.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import app.gameguidego.android.data.LocalGuideFile
import app.gameguidego.android.databinding.ItemLocalGuideBinding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class LocalGuideAdapter(
    private val onIngest: (LocalGuideFile) -> Unit,
    private val onPreview: (LocalGuideFile) -> Unit,
    private val onDelete: (LocalGuideFile) -> Unit
) : RecyclerView.Adapter<LocalGuideAdapter.ViewHolder>() {

    private val items = mutableListOf<LocalGuideFile>()
    private val dateFormat = SimpleDateFormat("MMM dd, HH:mm", Locale.getDefault())

    fun submitList(newItems: List<LocalGuideFile>) {
        items.clear()
        items.addAll(newItems)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemLocalGuideBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return ViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(items[position])
    }

    override fun getItemCount(): Int = items.size

    inner class ViewHolder(private val binding: ItemLocalGuideBinding) :
        RecyclerView.ViewHolder(binding.root) {
        fun bind(item: LocalGuideFile) {
            binding.txtGuideFilename.text = item.name
            val kb = (item.sizeBytes / 1024.0).coerceAtLeast(0.1)
            val dateStr = dateFormat.format(Date(item.modifiedAt))
            binding.txtGuideMeta.text = String.format(Locale.getDefault(), "%.1f KB · %s", kb, dateStr)

            binding.btnItemIngest.setOnClickListener { onIngest(item) }
            binding.btnItemPreview.setOnClickListener { onPreview(item) }
            binding.btnItemDelete.setOnClickListener { onDelete(item) }
        }
    }
}
