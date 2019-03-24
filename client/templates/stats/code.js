import { Template } from 'meteor/templating'
import { Vocabulary } from '/client/model/vocabulary'
import chat from 'chart.js'

const loadData = () => {
  const indices = Vocabulary.indices()
  const total = Vocabulary.count()
  const attempts = Vocabulary.count(e => e[indices.attempts])
  const successes = Vocabulary.count(e => e[indices.successes])
  const failures = attempts - successes
  const unseen = total - attempts
  return { total, successes, failures, unseen }
}

Template.stats.helpers({
  data: () => loadData(),
  noData: () => loadData().total <= 0
})

Template.stats.events({
  // 'click .flashcard > .error > .option': function (event) {
  //   if (this.extra) {
  //     transition();
  //     Timing.addExtraCards(this.extra);
  //   } else if (this.link) {
  //     Router.go(this.link);
  //   } else {
  //     console.error('Unable to apply option:', this);
  //   }
  // }
})

Template.stats.onRendered(function () {
  const data = loadData()
  if (data.total <= 0) return
  const ctx = this.find('#stats-chart').getContext('2d')
  const chart = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: ['Correct', 'Wrong', 'Unseen'],
      datasets: [{
        data: [data.successes, data.failures, data.unseen],
        backgroundColor: ['#88c874', '#e87878', '#444444']
      }]
    },
    options: {
      animation: false
    }
  })
})
